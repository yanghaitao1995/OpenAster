Android offline third-party notices

android-notices.json is the deterministic, checked-in source asset consumed by
the mobile preparation step. It contains public dependency information only.
It has no timestamp, absolute path, user configuration, credentials, APK path,
or APK hash. The asset must not be regenerated as part of every APK build.

Scope and evidence

The reviewed native runtime closure comes from the MAIN debug package section
of the local Android Gradle Plugin lint dependency model. The inventory input
is release/native-notices/third-party/android-native-inventory.json. Its APK
and build-receipt sections are deliberately omitted from this distributable
asset. Three local XML metadata hashes and a deterministic component snapshot
hash bind the component evidence to the generation inputs, not to an APK or
to the authenticity of a Gradle invocation.

All 46 selected Maven AAR/JAR files and their publisher POM declarations were
read again and matched to their inventory SHA-256 hashes. Every selected POM
declares Apache 2.0. Eight AndroidX AAR files contain identical Apache 2.0
LICENSE.txt bytes containing the complete numbered terms (without the
application appendix). The full standard text including the appendix comes
from the existing repository LICENSE, whose hash appears in licenses[].sources.
Its numbered terms match the artifact texts exactly after trimming outer
whitespace. The eight artifact entry paths/hashes are corroboratingSources.
Copyright placeholders in that standard appendix are upstream usage examples,
not copyright statements invented for any component. The other 38 Maven
artifacts are linked to that standard text by their own POM declarations;
this does not invent a component-specific copyright or NOTICE.

Capacitor Android and Core 8.5.3 each provide the MIT LICENSE used here. Their
package metadata, version, full license, and bridge source hashes are kept.
The MIT text preserves the actual upstream Drifty Co. copyright statement.
The native bridge shipped by @capacitor/android is explicitly covered; the
@capacitor/core package license is also included for the JavaScript/web side.

The generator searches named LICENSE/LICENCE/NOTICE/COPYING/COPYRIGHT entries
in each original AAR/JAR and nested JAR, plus notice files at the Capacitor
package roots. No independent NOTICE was found in these local inputs. This
is a search result, not a statement that no upstream NOTICE or other notice
obligation exists. Upstream source distributions have not all been reviewed.
An unfamiliar license text, changed declaration/hash, or populated generated
Cordova plugin project stops regeneration for review.

:capacitor-cordova-android-plugins is a generated container. Its checked
source tree currently has only an empty Android manifest and .gitkeep files;
there are no Java/Kotlin plugin files, plugin resources or local JARs. Its
Gradle configuration references the separately listed Cordova framework.
No standalone license or copyright is invented for this generated project.

Excluded: other build variants/platforms, arbitrary web/JavaScript packages,
remote services, platform WebView/Android SDK, build and test tools, and a
class-by-class D8/R8 analysis. The evidence is not a legal certification.

Updating after a dependency change

1. Produce and review a fresh local MAIN debug dependency-model snapshot and
   native inventory using scripts/android-native-inventory.py. Preserve the
   original evidence; use a new inventory destination when appropriate.
2. Review the selected runtime component set, actual local POM declarations,
   original AAR/JAR notices, Capacitor package LICENSE files, and generated
   Cordova plugin source tree. Add any actual upstream NOTICE material found.
   Never infer copyright owners or missing notice text from package names.
3. Update the deliberately bounded count/version/hash guards in
   scripts/prepare-android-notices.py only after that review. Run locally:
     python scripts/prepare-android-notices.py
   Or select a reviewed inventory with --inventory repository/relative.json.
   This command uses Python's standard library, reads local inputs only,
   and writes only mobile/notices/android-notices.json. It never reads,
   modifies, builds, signs, or installs an APK and does not access a network.
4. Check deterministic regeneration:
     python scripts/prepare-android-notices.py --check
   Review the resulting component list, full texts, source hashes and gaps.
5. Run the normal mobile preparation/build process to copy the reviewed
   asset into the app. Verify the packaged asset and the offline reader.

Schema for consumers

schemaVersion is 1. components[] contains id, name, version, kind, licenseIds,
declarations, evidence, licenseEvidence, licenseTextBasis, human-readable
noticeStatus, and notices[]. licenses[] maps ids to exact UTF-8 full text,
sha256 and sources. A source uses repository-relative path and optional
archive entry, with original byte count/hash. notices[] contains actual
discovered notice text, never an invented placeholder. scope.limitations,
coverageGaps and generatedProjects describe what is and is not established.
Render all dependency-provided strings as plain text, never executable HTML.
The componentSnapshotSha256 is SHA-256 of UTF-8 JSON for {components,
metadataEvidence,generatedProjects} with sorted keys, compact separators,
and unescaped Unicode; it is independent of the APK and display wording
outside those objects.
