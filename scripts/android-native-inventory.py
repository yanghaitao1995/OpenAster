#!/usr/bin/env python3
"""Offline inventory of AGP MAIN-variant package inputs; no Gradle or network.

Example (run from the repository):
  python scripts/android-native-inventory.py --apk release/example/app.apk \
    --receipt release/example/android-build-receipt.json --output out/android.json \
    --extract-notices out/android-notices \
    --project-package :capacitor-android=node_modules/@capacitor/android/package.json

The lint package model records resolved runtime inputs, not a class-by-class
proof of surviving APK code. POM license declarations are not license texts.
"""
import argparse
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MODEL = "mobile/android/app/build/intermediates/lint_report_lint_model/debug/generateDebugLintReportModel"
CACHE = ".gradle-cache/caches/modules-2/files-2.1"
COORD = re.compile(r"^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+-]+)@(aar|jar)$")
NOTICE = re.compile(r"(?:^|/)(?:licen[cs]e(?:s)?|notice|copying|copyright)(?:[._-].*)?$", re.I)
MAX_TEXT = 8 * 1024 * 1024


class InventoryError(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inside(root, value, must_exist=True):
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    if not path.is_relative_to(root):
        raise InventoryError(f"Path outside project root: {value}")
    if must_exist and not path.exists():
        raise InventoryError(f"Missing input: {value}")
    return path


def evidence(root, path):
    path = inside(root, path)
    data = path.read_bytes()
    return {"path": path.relative_to(root).as_posix(), "bytes": len(data), "sha256": sha(data)}


def xml(root, path):
    data = inside(root, path).read_bytes()
    if len(data) > MAX_TEXT:
        raise InventoryError(f"XML exceeds size limit: {path}")
    # Reject non-UTF-8 and all declarations before ElementTree sees the input.
    text = data.decode("utf-8-sig")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise InventoryError(f"DTD/entity declarations are forbidden: {path}")
    return ET.fromstring(text)


def local_tag(element):
    return element.tag.rsplit("}", 1)[-1]


def child(element, name):
    return next((item for item in element if local_tag(item) == name), None)


def value(element, name):
    item = child(element, name)
    return item.text.strip() if item is not None and item.text else None


def unique_cached(root, cache, parts, suffix):
    if len(parts) != 3 or any(not re.fullmatch(r"[A-Za-z0-9_.+-]+", p) or p in (".", "..") for p in parts):
        raise InventoryError("Unsupported Maven coordinates")
    directory = inside(root, cache.joinpath(*parts), must_exist=False)
    if not directory.exists():
        return None
    matches = sorted(directory.glob(f"*/{parts[1]}-{parts[2]}.{suffix}"))
    for path in matches:
        inside(root, path)
    if len({sha(p.read_bytes()) for p in matches}) > 1:
        raise InventoryError(f"Ambiguous cached {suffix}: {':'.join(parts)}")
    return matches[0] if matches else None


def pom_licenses(root, cache, parts, gaps, evidence_list, seen=None):
    seen = set() if seen is None else seen
    key = ":".join(parts)
    if key in seen or len(seen) > 20:
        raise InventoryError(f"Cyclic/excessive POM inheritance: {key}")
    seen.add(key)
    path = unique_cached(root, cache, parts, "pom")
    if path is None:
        gaps.append({"code": "pom_missing", "component": key})
        return []
    evidence_list.append(evidence(root, path))
    try:
        doc = xml(root, path)
    except (UnicodeError, ET.ParseError) as error:
        gaps.append({"code": "pom_unreadable_by_reader", "component": key, "errorType": type(error).__name__})
        return []
    parent = child(doc, "parent")
    actual = [value(doc, "groupId") or (value(parent, "groupId") if parent is not None else None),
              value(doc, "artifactId"), value(doc, "version") or (value(parent, "version") if parent is not None else None)]
    if actual != parts:
        raise InventoryError(f"POM coordinate/version mismatch for {key}: {actual}")
    licenses = child(doc, "licenses")
    if licenses is not None:
        declarations = [{"name": value(item, "name"), "url": value(item, "url"),
                         "distribution": value(item, "distribution"), "sourcePom": evidence_list[-1]["path"],
                         "evidenceKind": "publisher-declaration-not-license-text"}
                        for item in licenses if local_tag(item) == "license"]
        usable = [item for item in declarations if item["name"] or item["url"]]
        if not usable or len(usable) != len(declarations):
            gaps.append({"code": "license_declaration_empty", "component": key})
        if usable:
            return usable
    if parent is not None:
        inherited = [value(parent, item) for item in ("groupId", "artifactId", "version")]
        if all(inherited):
            return pom_licenses(root, cache, inherited, gaps, evidence_list, seen)
    if licenses is None:
        gaps.append({"code": "license_declaration_missing", "component": key})
    return []


def notice_entries(data, source, payloads, nested=True):
    notices = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(set(names)) != len(names):
            raise InventoryError(f"Duplicate archive entries: {source}")
        for info in archive.infolist():
            if NOTICE.search(info.filename) and not info.is_dir():
                if info.file_size > MAX_TEXT:
                    raise InventoryError(f"Notice exceeds size limit: {source}!{info.filename}")
                content = archive.read(info)
                digest = sha(content)
                payloads[digest] = content
                notices.append({"source": source, "entry": info.filename, "sha256": digest, "bytes": len(content)})
            elif nested and info.filename == "classes.jar":
                if info.file_size > 128 * 1024 * 1024:
                    raise InventoryError(f"Nested classes.jar exceeds size limit: {source}")
                notices.extend(notice_entries(archive.read(info), source + "!classes.jar", payloads, False))
    return notices


def generate(root, apk, dependencies, libraries, cache=CACHE, receipt=None, project_packages=None):
    root = Path(root).resolve()
    apk = inside(root, apk)
    dep_path, lib_path, cache = (inside(root, p) for p in (dependencies, libraries, cache))
    deps, libs = xml(root, dep_path), xml(root, lib_path)
    if deps.tag != "dependencies" or libs.tag != "libraries":
        raise InventoryError("Unexpected AGP model root")
    variant_name = dep_path.name.removesuffix("-artifact-dependencies.xml")
    variant_path = inside(root, dep_path.parent / (variant_name + ".xml"))
    variant = xml(root, variant_path)
    if variant.get("name") != variant_name or variant.find("artifact") is None or variant.find("artifact").get("type") != "MAIN":
        raise InventoryError("Only matching MAIN variant models are accepted; test models are not runtime evidence")
    package, compile_section = deps.find("package"), deps.find("compile")
    if package is None or compile_section is None:
        raise InventoryError("Model must have separate package and compile sections")
    runtime = {item.get("name") for item in package.iter("dependency")}
    compile_names = {item.get("name") for item in compile_section.iter("dependency")}
    roots = set(filter(None, package.get("roots", "").split(",")))
    if not runtime or None in runtime or not roots or not roots.issubset(runtime):
        raise InventoryError("Incomplete package dependency graph")
    mapping = {}
    for item in libs:
        name = item.get("name")
        if not name or name in mapping:
            raise InventoryError("Missing or duplicate library mapping")
        mapping[name] = item
    if not (runtime | compile_names).issubset(mapping):
        raise InventoryError("Incomplete library mapping")
    gaps, components, payloads = [], [], {}
    inputs = [evidence(root, path) for path in (dep_path, lib_path, variant_path)]
    apk_evidence = evidence(root, apk)
    if receipt:
        receipt_path = inside(root, receipt)
        record = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
        if record.get("sha256", "").lower() != apk_evidence["sha256"] or record.get("bytes") != apk_evidence["bytes"]:
            raise InventoryError("APK does not match build receipt hash/size")
        inputs.append(evidence(root, receipt_path))
        apk_evidence["receiptVersion"] = {key: record.get(key) for key in ("versionCode", "versionName")}
    else:
        gaps.append({"code": "build_receipt_not_supplied"})
    with zipfile.ZipFile(apk) as archive:
        apk_names = set(archive.namelist())
        apk_notices = notice_entries(apk.read_bytes(), apk_evidence["path"], payloads, False)
        if not apk_notices:
            gaps.append({"code": "apk_has_no_named_license_or_notice_entries"})
        markers = {name: archive.read(name).decode("utf-8", "replace").strip() for name in apk_names if name.startswith("META-INF/") and name.endswith(".version")}
        inline_mentions = []
        for info in archive.infolist():
            if Path(info.filename).suffix.lower() in (".js", ".mjs", ".html", ".txt", ".json") and info.file_size <= MAX_TEXT:
                data = archive.read(info)
                mentions = sorted(set(re.findall(r"MIT License|Apache License(?:, Version 2\.0)?|Copyright[^\r\n]{0,160}", data.decode("utf-8", "replace"), re.I)))
                if mentions:
                    inline_mentions.append({"entry": info.filename, "sha256": sha(data), "matches": mentions,
                                            "evidenceKind": "text-mention-not-proof-of-full-license"})
    selected_versions = {}
    for name in sorted(runtime):
        item = mapping[name]
        component = {"id": name, "scope": "package", "alsoCompileInput": name in compile_names, "notices": []}
        if item.get("project"):
            if name != f":@@{item.get('project')}::{variant_name}":
                raise InventoryError(f"Project mapping/variant mismatch: {name}")
            component.update(kind="local-project", project=item.get("project"))
            package_path = (project_packages or {}).get(item.get("project"))
            if package_path:
                package_path = inside(root, package_path)
                package_json = json.loads(package_path.read_text(encoding="utf-8-sig"))
                component["npmPackage"] = {key: package_json.get(key) for key in ("name", "version", "license")}
                component["packageAssociation"] = "explicit-project-package-argument"
                component["packageEvidence"] = evidence(root, package_path)
                for license_path in sorted(package_path.parent.iterdir()):
                    if license_path.is_file() and NOTICE.search(license_path.name):
                        entry = evidence(root, license_path)
                        payloads[entry["sha256"]] = inside(root, license_path).read_bytes()
                        component["notices"].append({"source": entry["path"], "sha256": entry["sha256"], "bytes": entry["bytes"]})
            else:
                gaps.append({"code": "local_project_license_metadata_not_supplied", "component": name})
            components.append(component)
            continue
        match = COORD.fullmatch(name)
        if not match:
            raise InventoryError(f"Unsupported runtime coordinate: {name}")
        group, artifact, version, extension = match.groups()
        key = (group, artifact)
        if key in selected_versions and selected_versions[key] != version:
            raise InventoryError(f"Conflicting selected versions: {group}:{artifact}")
        selected_versions[key] = version
        if item.get("resolved") != f"{group}:{artifact}:{version}":
            raise InventoryError(f"Library coordinate/version mismatch: {name}")
        component.update(kind="maven", group=group, artifact=artifact, version=version, packaging=extension)
        if item.get("folder"):
            component["transformedFolder"] = inside(root, item.get("folder")).relative_to(root).as_posix()
        jar_paths = list(filter(None, item.get("jars", "").split(";")))
        if not jar_paths:
            raise InventoryError(f"Runtime library has no artifact mapping: {name}")
        component["mappedArtifacts"] = [evidence(root, path) for path in jar_paths]
        original = unique_cached(root, cache, [group, artifact, version], extension)
        if original:
            component["originalArtifact"] = evidence(root, original)
            component["notices"] = notice_entries(original.read_bytes(), component["originalArtifact"]["path"], payloads)
        else:
            gaps.append({"code": "original_artifact_missing", "component": name})
        component["pomEvidence"] = []
        component["declaredLicenses"] = pom_licenses(root, cache, [group, artifact, version], gaps, component["pomEvidence"])
        if not component["notices"]:
            gaps.append({"code": "no_license_text_in_selected_artifact", "component": name})
        marker = f"META-INF/{group}_{artifact}.version"
        if group == "org.jetbrains.kotlinx":
            marker = "META-INF/" + artifact.replace("-jvm", "").replace("-", "_") + ".version"
        if marker in markers:
            marker_version = markers[marker]
            component["apkVersionMarker"] = {"entry": marker, "value": marker_version}
            if re.fullmatch(r"[0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9_.-]+)?", marker_version):
                if marker_version != version:
                    raise InventoryError(f"APK version marker mismatch: {name} has {marker_version}")
            else:
                gaps.append({"code": "apk_version_marker_not_a_version", "component": name, "entry": marker})
        else:
            gaps.append({"code": "apk_version_marker_unavailable", "component": name})
        components.append(component)
    return {"schemaVersion": 1, "platform": "android", "variant": variant_name,
            "scope": "AGP MAIN package dependency closure (resolved runtime inputs)",
            "apk": apk_evidence, "metadataEvidence": inputs, "components": components,
            "compileOnly": sorted(compile_names - runtime), "apkNotices": apk_notices,
            "apkTextLicenseMentions": inline_mentions,
            "counts": {"runtimeComponents": len(components), "maven": sum(c["kind"] == "maven" for c in components),
                       "localProjects": sum(c["kind"] == "local-project" for c in components)},
            "coverageGaps": gaps,
            "limitations": ["Metadata hashes bind this report to the supplied snapshot, not cryptographically to a Gradle invocation.",
                            "Resolved package inputs do not prove every class survives D8/R8 or is used at runtime.",
                            "Web/JavaScript assets require a separate inventory; platform WebView/Android SDK and build/test tools are outside this closure.",
                            "Named-notice extraction and bounded text-mention searches are not an exhaustive analysis of embedded copyright/license information.",
                            "POM declarations and extracted notices are evidence, not a legal compliance certification."]}, payloads


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=".")
    parser.add_argument("--apk", required=True)
    parser.add_argument("--dependencies", default=MODEL + "/debug-artifact-dependencies.xml")
    parser.add_argument("--libraries", default=MODEL + "/debug-artifact-libraries.xml")
    parser.add_argument("--cache", default=CACHE)
    parser.add_argument("--receipt")
    parser.add_argument("--output", required=True)
    parser.add_argument("--extract-notices")
    parser.add_argument("--project-package", action="append", default=[], metavar="PROJECT=PACKAGE_JSON")
    args = parser.parse_args()
    try:
        root = Path(args.root).resolve()
        packages = {}
        for item in args.project_package:
            if "=" not in item:
                raise InventoryError("--project-package requires PROJECT=PACKAGE_JSON")
            project, path = item.split("=", 1)
            packages[project] = path
        output = inside(root, args.output, must_exist=False)
        extract = inside(root, args.extract_notices, must_exist=False) if args.extract_notices else None
        report, payloads = generate(root, args.apk, args.dependencies, args.libraries, args.cache, args.receipt, packages)
        def input_paths(item):
            if isinstance(item, dict):
                if "path" in item and "sha256" in item:
                    yield item["path"]
                for nested_item in item.values():
                    yield from input_paths(nested_item)
            elif isinstance(item, list):
                for nested_item in item:
                    yield from input_paths(nested_item)
        if output.relative_to(root).as_posix() in set(input_paths(report)):
            raise InventoryError("Output would overwrite an inventory input")
        if output.exists():
            raise InventoryError("Output already exists; choose a new report path")
        if extract:
            # Digest filenames avoid archive-path traversal and preserve original bytes.
            extract.mkdir(parents=True, exist_ok=True)
            for digest, content in sorted(payloads.items()):
                destination = inside(root, extract / (digest + ".txt"), must_exist=False)
                if destination.exists():
                    if destination.read_bytes() != content:
                        raise InventoryError(f"Existing notice content differs: {destination}")
                else:
                    with destination.open("xb") as stream:
                        stream.write(content)
            report["extractedNotices"] = [{"sha256": digest, "path": (extract / (digest + ".txt")).relative_to(root).as_posix()} for digest in sorted(payloads)]
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"output": str(output), "counts": report["counts"], "coverageGapCount": len(report["coverageGaps"])}))
        return 0
    except (InventoryError, OSError, UnicodeError, ET.ParseError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f"android-native-inventory: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
