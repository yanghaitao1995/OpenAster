#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Give only this non-root process tree the existing KVM primary group.
set -euo pipefail

blocked() { printf '::error::Android acceptance blocked: %s\n' "$1" >&2; exit 1; }
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted &&
  "${GITHUB_REPOSITORY:-}" == yanghaitao1995/OpenAster && "$(uname -s)" == Linux &&
  "$(uname -m)" == x86_64 ]] || blocked 'an ephemeral repository Linux x64 runner is required'
runner_uid="$(id -u)"
[[ "$runner_uid" =~ ^[1-9][0-9]*$ && "$(id -ru)" == "$runner_uid" ]] || blocked 'the original runner must be non-root'
[[ -n "${GITHUB_WORKSPACE:-}" && "$(pwd -P)" == "$(cd "$GITHUB_WORKSPACE" && pwd -P)" ]] || blocked 'the workflow checkout must be the working directory'
node_bin="$(command -v node)"
[[ "$node_bin" == /* && -x "$node_bin" ]] || blocked 'the configured Node executable is unavailable'
[[ -n "${JAVA_HOME_21_X64:-}" && -n "${ANDROID_HOME:-}" && -n "${RUNNER_TEMP:-}" && -n "${GITHUB_SHA:-}" ]] || blocked 'required SDK or workflow context is missing'

evidence="$GITHUB_WORKSPACE/android-installer-evidence"
[[ ! -L "$evidence" ]] || blocked 'the evidence directory must not be a link'
mkdir -p "$evidence"
wrapper_receipt="$evidence/kvm-wrapper-receipt.json"
[[ ! -e "$wrapper_receipt" && ! -L "$wrapper_receipt" ]] || blocked 'the KVM wrapper receipt already exists'
wrapper_status=blocked
kvm_gid_json=null
device_before=unavailable
account_groups_before="$(id -G "$runner_uid")"
device_snapshot() { [[ -c /dev/kvm && ! -L /dev/kvm ]] && stat -c '%d:%i:%t:%T:%u:%g:%a' /dev/kvm; }
finish() {
  local result=$? device_after device_unchanged=false account_groups_unchanged=false
  trap - EXIT
  device_after="$(device_snapshot)" || device_after=unavailable
  if [[ "$device_before" != unavailable && "$device_before" == "$device_after" ]]; then device_unchanged=true; fi
  if [[ "$(id -G "$runner_uid")" == "$account_groups_before" ]]; then account_groups_unchanged=true; fi
  if [[ "$device_unchanged" != true || "$account_groups_unchanged" != true ]]; then
    printf '::error::Android acceptance blocked: KVM device or runner account groups changed, or the device was unavailable\n' >&2
    wrapper_status=blocked
    result=1
  elif (( result == 0 )); then wrapper_status=passed; fi
  printf '{"format":"openaster-kvm-wrapper-v1","launcher":"system-setpriv","status":"%s","runnerUid":%s,"kvmGid":%s,"deviceBefore":"%s","deviceAfter":"%s","deviceUnchanged":%s,"accountGroupsUnchanged":%s,"permissionMutationRequested":false,"exitCode":%s}\n' \
    "$wrapper_status" "$runner_uid" "$kvm_gid_json" "$device_before" "$device_after" "$device_unchanged" "$account_groups_unchanged" "$result" > "$wrapper_receipt"
  exit "$result"
}
trap finish EXIT

group_entry="$(getent group kvm)" || blocked 'the existing kvm group is unavailable; no permissions were changed'
IFS=: read -r group_name group_password kvm_gid group_members <<< "$group_entry"
[[ "$group_name" == kvm && "$kvm_gid" =~ ^[1-9][0-9]*$ ]] || blocked 'the existing kvm group is invalid'
kvm_gid_json="$kvm_gid"
device_before="$(device_snapshot)" || blocked '/dev/kvm must be an existing character device without links'
[[ "$(stat -c '%u:%g' /dev/kvm)" == "0:$kvm_gid" ]] || blocked '/dev/kvm must retain its existing root:kvm ownership'

# Only the root-owned system launcher runs as root. It drops all user IDs,
# primary group IDs and capabilities before env, Node or project code loads.
[[ -f /usr/bin/setpriv && ! -L /usr/bin/setpriv && -x /usr/bin/setpriv &&
  ! -w /usr/bin/setpriv && "$(stat -c '%u' /usr/bin/setpriv)" == 0 ]] || blocked 'the root-owned system setpriv launcher is unavailable'
drop_privileges=(/usr/bin/sudo -n --user=root -- /usr/bin/setpriv
  "--reuid=$runner_uid" "--regid=$kvm_gid" --init-groups
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs --)
if ! /usr/bin/timeout --kill-after=5s 15s "${drop_privileges[@]}" /usr/bin/true; then
  blocked 'sudo/setpriv could not establish the non-root KVM context; no permissions were changed'
fi
wrapper_status=failed
acceptance_exit=0
"${drop_privileges[@]}" /usr/bin/env -i \
  PATH="$JAVA_HOME_21_X64/bin:$PATH" LANG=C.UTF-8 \
  JAVA_HOME="$JAVA_HOME_21_X64" ANDROID_HOME="$ANDROID_HOME" \
  GITHUB_ACTIONS="$GITHUB_ACTIONS" RUNNER_ENVIRONMENT="$RUNNER_ENVIRONMENT" \
  GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_WORKSPACE="$GITHUB_WORKSPACE" \
  GITHUB_SHA="$GITHUB_SHA" RUNNER_TEMP="$RUNNER_TEMP" \
  OPENASTER_KVM_RUNNER_UID="$runner_uid" OPENASTER_KVM_GID="$kvm_gid" OPENASTER_KVM_DEVICE="$device_before" \
  "$node_bin" scripts/verify-published-android.mjs --candidate || acceptance_exit=$?
if (( acceptance_exit != 0 )); then
  if [[ ! -f "$evidence/receipt.json" ]]; then
    wrapper_status=blocked
    printf '::error::Android acceptance blocked: sudo or the verifier could not start; no permissions were changed\n' >&2
  fi
  exit "$acceptance_exit"
fi
