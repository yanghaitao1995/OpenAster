#!/usr/bin/env python3
"""Prepare the checked-in Android notices asset from local, verified inputs only.

No Gradle invocation, network, APK reads/writes, timestamps, or absolute paths.
The inventory supplies the resolved debug closure; every POM/artifact is re-read.
"""
import argparse
import importlib.util
import io
import json
import re
import sys
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("android_inventory", Path(__file__).with_name("android-native-inventory.py"))
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)

DEFAULT_INVENTORY = "release/native-notices/third-party/android-native-inventory.json"
DEFAULT_OUTPUT = "mobile/notices/android-notices.json"
APACHE_TERMS_SHA256 = "809fa1ed21450f59827d1e9aec720bbc4b687434fa22283c6cb5dd82a47ab9c0"
APACHE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
MIT_SHA256 = "9c6ebf3e5ab832ba4d5af38f340978e1fedbfee6e3d23662dfdb8917a9d864dd"
NOTICE_NAME = re.compile(r"(?:^|/)(?:notice|copying|copyright)(?:[._-].*)?$", re.I)
APACHE_URL = re.compile(r"^https?://(?:www\.)?apache\.org/licenses/LICENSE-2\.0(?:\.txt)?/?$", re.I)


def require(condition, message):
    if not condition:
        raise inventory.InventoryError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def verified(root, expected):
    actual = inventory.evidence(root, expected["path"])
    require(actual == expected, f"Input differs from inventory: {expected['path']}")
    return actual


def text(data):
    result = data.decode("utf-8")
    require(not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", result), "License/notice is not plain UTF-8 text")
    return result


def archive_texts(data, source, depth=0):
    """Read named license/notice files and nested JARs without extracting paths."""
    require(depth <= 4, "Excessive nested archive depth")
    require(len(data) <= 128 * 1024 * 1024, "Archive exceeds bounded reader size")
    found = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        require(len(names) <= 65536 and len(set(names)) == len(names), "Excessive/duplicate archive entries")
        for entry in sorted(archive.infolist(), key=lambda item: item.filename):
            if entry.is_dir():
                continue
            if inventory.NOTICE.search(entry.filename):
                require(entry.file_size <= inventory.MAX_TEXT, "License/notice exceeds bounded reader size")
                content = archive.read(entry)
                found.append({"name": entry.filename, "text": text(content), "sha256": inventory.sha(content),
                              "source": {"path": source["path"], "entry": entry.filename,
                                         "bytes": len(content), "sha256": inventory.sha(content)}})
            elif entry.filename.lower().endswith(".jar"):
                require(entry.file_size <= 128 * 1024 * 1024, "Nested JAR exceeds bounded reader size")
                nested_source = {"path": source["path"]}
                for item in archive_texts(archive.read(entry), nested_source, depth + 1):
                    item["source"]["entry"] = entry.filename + "!" + item["source"]["entry"]
                    found.append(item)
    return found


def generated_project(root):
    project = "mobile/android/capacitor-cordova-android-plugins"
    directory = inventory.inside(root, project)
    permitted = {"build.gradle", "cordova.variables.gradle", "src/main/AndroidManifest.xml",
                 "src/main/java/.gitkeep", "src/main/res/.gitkeep"}
    files = sorted(p for p in directory.rglob("*") if p.is_file()
                   and not {"build", ".gradle"}.intersection(p.relative_to(directory).parts))
    relative = {p.relative_to(directory).as_posix() for p in files}
    require(relative.issubset(permitted), "Generated Cordova project has new files; review plugin licenses before regeneration")
    require({"build.gradle", "cordova.variables.gradle", "src/main/AndroidManifest.xml"}.issubset(relative),
            "Generated Cordova project evidence is incomplete")
    manifest = inventory.xml(root, directory / "src/main/AndroidManifest.xml")
    require(all(child.tag == "application" and not list(child) and not child.attrib for child in manifest),
            "Generated Cordova project manifest changed; review plugin scope")
    return {"name": ":capacitor-cordova-android-plugins", "sourceFileCount": 0,
            "description": "Capacitor 生成的 Cordova 插件容器；当前没有 Java/Kotlin 插件源码、插件资源或本地 JAR。构建配置引用的 Cordova framework 已作为 Maven 组件列出。未为此生成项目编造独立许可。",
            "evidence": [inventory.evidence(root, p) for p in files]}


def generate(root, inventory_path=DEFAULT_INVENTORY):
    root = Path(root).resolve()
    inventory_path = inventory.inside(root, inventory_path)
    original = json.loads(inventory_path.read_text(encoding="utf-8-sig"))
    require(original.get("platform") == "android" and original.get("variant") == "debug", "Only the reviewed Android debug closure is supported")
    require(original.get("counts") == {"runtimeComponents": 48, "maven": 46, "localProjects": 2},
            "Dependency closure changed; review the new component set before regeneration")
    metadata = [verified(root, e) for e in original["metadataEvidence"] if e["path"].endswith(".xml")]
    require(len(metadata) == 3, "Expected the three MAIN debug lint model inputs")
    variant_evidence = next(e for e in metadata if Path(e["path"]).name == "debug.xml")
    variant = inventory.xml(root, variant_evidence["path"])
    require(variant.get("name") == "debug" and variant.find("artifact") is not None
            and variant.find("artifact").get("type") == "MAIN", "Only the MAIN debug variant is covered")
    dependencies = next(e for e in metadata if e["path"].endswith("-artifact-dependencies.xml"))
    dependency_doc = inventory.xml(root, dependencies["path"])
    package = dependency_doc.find("package")
    require(package is not None, "Missing package closure")
    runtime_ids = {item.get("name") for item in package.iter("dependency")}
    require(runtime_ids == {c["id"] for c in original["components"]}, "Inventory and package dependency closure differ")

    components, apache_sources, apache_text, maven_without_text = [], [], None, []
    for component in sorted(original["components"], key=lambda item: item["id"]):
        if component["kind"] != "maven":
            continue
        artifact = verified(root, component["originalArtifact"])
        pom_evidence, gaps = [], []
        declarations = inventory.pom_licenses(root, inventory.inside(root, inventory.CACHE),
                                             [component[key] for key in ("group", "artifact", "version")],
                                             gaps, pom_evidence)
        require(not gaps and declarations == component["declaredLicenses"] and pom_evidence == component["pomEvidence"],
                f"POM declarations changed or incomplete: {component['id']}")
        require(all("Apache" in (d["name"] or "") and "2.0" in (d["name"] or "")
                    and APACHE_URL.fullmatch(d["url"] or "") for d in declarations),
                f"Unreviewed license declaration: {component['id']}")
        embedded = archive_texts(inventory.inside(root, artifact["path"]).read_bytes(), artifact)
        license_evidence, notices = [], []
        for item in embedded:
            if NOTICE_NAME.search(item["name"]):
                notices.append(item)
            else:
                require(item["sha256"] == APACHE_TERMS_SHA256, f"Unreviewed embedded license text: {component['id']}!{item['name']}")
                apache_text = item["text"]
                apache_sources.append(item["source"])
                license_evidence.append(item["source"])
        if not license_evidence:
            maven_without_text.append(component["id"])
        components.append({
            "id": component["id"], "name": component["group"] + ":" + component["artifact"],
            "version": component["version"], "kind": "maven", "licenseIds": ["Apache-2.0"],
            "declarations": [{"name": d["name"], "url": d["url"],
                              "source": next(e for e in pom_evidence if e["path"] == d["sourcePom"])} for d in declarations],
            "evidence": [artifact] + pom_evidence, "licenseEvidence": license_evidence,
            "licenseTextBasis": "artifact-license-text" if license_evidence else "publisher-declaration-with-shared-standard-text",
            "noticeStatus": "已收录本地制品内发现的命名通知文件；不代表对上游全部通知义务的认证。" if notices else
                            "已检查原始 AAR/JAR 及其内嵌 JAR，未发现命名 NOTICE 文件；这不证明上游没有其他通知义务。",
            "notices": notices,
        })
    apache_full_source = inventory.evidence(root, "LICENSE")
    require(apache_full_source["sha256"] == APACHE_SHA256, "Repository standard Apache 2.0 text changed")
    apache_full_text = text(inventory.inside(root, "LICENSE").read_bytes())
    require(apache_text is not None and "END OF TERMS AND CONDITIONS" in apache_text
            and "APPENDIX" in apache_full_text and apache_text.strip() == apache_full_text.split("   APPENDIX:")[0].strip(),
            "Repository Apache 2.0 terms differ from verified artifact texts")

    mit_sources, mit_text = [], None
    local_android = next(c for c in original["components"] if c.get("project") == ":capacitor-android")
    for package_name in ("android", "core"):
        directory = inventory.inside(root, "node_modules/@capacitor/" + package_name)
        package_evidence = inventory.evidence(root, directory / "package.json")
        package = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        require(package["name"] == "@capacitor/" + package_name and package["version"] == local_android["npmPackage"]["version"]
                and package.get("license") == "MIT", "Capacitor package/version/license changed")
        if package_name == "android":
            require(package_evidence == local_android["packageEvidence"], "Capacitor Android package metadata changed")
        license_evidence = inventory.evidence(root, directory / "LICENSE")
        require(license_evidence["sha256"] == MIT_SHA256, "Capacitor MIT text changed; review before regeneration")
        mit_text = text((directory / "LICENSE").read_bytes())
        mit_sources.append(license_evidence)
        bridge = directory / ("capacitor/src/main/assets/native-bridge.js" if package_name == "android" else "dist/capacitor.js")
        bridge_evidence = inventory.evidence(root, bridge)
        if package_name == "android":
            old_bridge = next(e for e in original["apkTextLicenseMentions"] if e["entry"] == "assets/native-bridge.js")
            require(bridge_evidence["sha256"] == old_bridge["sha256"], "Native bridge changed from the reviewed inventory")
        notices = []
        for path in sorted(directory.iterdir()):
            if path.is_file() and NOTICE_NAME.search(path.name):
                source = inventory.evidence(root, path)
                notices.append({"name": path.name, "text": text(path.read_bytes()), "sha256": source["sha256"], "source": source})
        components.append({"id": package["name"] + "@" + package["version"], "name": package["name"],
                           "version": package["version"], "kind": "npm", "licenseIds": ["MIT"],
                           "declarations": [{"name": "MIT", "source": package_evidence}],
                           "evidence": [package_evidence, bridge_evidence], "licenseEvidence": [license_evidence],
                           "licenseTextBasis": "package-license-text",
                           "noticeStatus": "已收录包根目录发现的命名通知文件。" if notices else "包根目录未发现独立 NOTICE 文件；MIT 原文中的版权声明已保留。",
                           "notices": notices})
    components.sort(key=lambda item: item["name"])
    generated = generated_project(root)
    limitations = [
        "范围是本地 AGP MAIN debug package 运行依赖闭包中的 46 个 Maven 组件，以及 Capacitor Android/Core 8.5.3 的许可；不是所有平台或所有构建变体的清单。",
        "组件与元数据哈希绑定生成时的本地输入快照，不构成对 Gradle 调用或最终 APK 字节的密码学证明；未包含 APK 自身哈希，以免循环构建。",
        "运行依赖输入不证明每个类都经过 D8/R8 后留在 APK 中或在运行时被使用。",
        "除显式列出的 Capacitor 包外，其他网页/JavaScript 依赖、远程服务、Android SDK、系统 WebView、构建及测试工具不在本清单范围内。",
        "命名 LICENSE/NOTICE/COPYING/COPYRIGHT 文件检查不是对嵌入版权信息的穷尽分析；未发现 NOTICE 不能证明上游没有通知义务。",
        "POM 是发布者的许可声明；通用 Apache 2.0 全文不补造各组件的版权或 NOTICE。此页提供可核对的许可材料，不宣称完成法律合规认证。",
    ]
    result = {"schemaVersion": 1, "title": "第三方开源许可", "platform": "android", "variant": "debug",
              "summary": "此离线页收录已确认的 46 个 Maven 组件和 Capacitor Android/Core 的 Apache 2.0、MIT 许可全文，保留本地可核对的声明与来源。",
              "scope": {"description": "生成时 Android debug 运行依赖闭包及显式补充的 Capacitor Core 网页桥接许可。",
                        "sourceInventory": inventory_path.relative_to(root).as_posix(),
                        "componentSnapshotSha256": inventory.sha(canonical({"components": components, "metadataEvidence": metadata, "generatedProjects": [generated]})),
                        "metadataEvidence": metadata, "limitations": limitations},
              "counts": {"maven": 46, "npm": 2, "components": len(components)},
              "licenses": [{"id": "Apache-2.0", "name": "Apache License, Version 2.0", "text": apache_full_text,
                            "sha256": APACHE_SHA256, "sources": [apache_full_source], "corroboratingSources": apache_sources,
                            "sourceDescription": "全文取自仓库已有标准 Apache 2.0 LICENSE；第 1–9 条与 8 个 AndroidX AAR 的 LICENSE.txt 一致，附录中的版权占位符是许可应用示例，不是组件版权声明。"},
                           {"id": "MIT", "name": "MIT License", "text": mit_text, "sha256": MIT_SHA256, "sources": mit_sources}],
              "components": components, "generatedProjects": [generated],
              "coverageGaps": [f"{len(maven_without_text)} 个 Maven 制品未内嵌命名许可全文；本页依据各自 POM 的 Apache 2.0 声明关联已从 AndroidX AAR 核验的标准全文。",
                               "本地所选制品未发现独立 NOTICE；尚未逐个核对全部上游源码发行包的通知材料。"],
              "componentsWithoutEmbeddedLicenseText": maven_without_text}
    require(len(components) == 48, "Unexpected component count")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--inventory", default=DEFAULT_INVENTORY)
    parser.add_argument("--check", action="store_true", help="Compare regenerated bytes with the checked-in asset")
    args = parser.parse_args()
    try:
        root = Path(args.root).resolve()
        result = generate(root, args.inventory)
        output = inventory.inside(root, DEFAULT_OUTPUT, must_exist=False)
        data = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        if args.check:
            require(output.read_bytes() == data, "Checked-in Android notices differ; regenerate and review")
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
        print(json.dumps({"output": DEFAULT_OUTPUT, "check": args.check, "counts": result["counts"],
                          "bytes": len(data), "sha256": inventory.sha(data)}, ensure_ascii=False))
        return 0
    except (inventory.InventoryError, OSError, UnicodeError, ValueError, KeyError, StopIteration, zipfile.BadZipFile) as error:
        print(f"prepare-android-notices: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
