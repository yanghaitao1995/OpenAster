// SPDX-License-Identifier: Apache-2.0
// Install the unchanged public APK in a fresh hosted-runner emulator. This is
// offline companion-client acceptance, not proof of a working HTTPS gateway.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APK = Object.freeze({ file: 'OpenAster-0.2.2-android-vc12-debug.apk', bytes: 4124497,
  sha256: '595b42481262d856c799a3c0186dcb2f4c113c291e7df94c9f21aa4b76b18e44',
  version: '0.2.2', versionCode: 12, package: 'org.openaster.preview',
  sharedAssetsSha256: 'e94a961b65abc4993a71fa409c2e9f7df95c9c3f8b52929653d4e127fad879ff' });
const IMAGE = 'system-images;android-36;default;x86_64';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const digest = async file => { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); };
const within = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const clean = value => String(value ?? '').replace(/\bhttps?:\/\/[^\s<>"']+/giu, '[URL]')
  .replace(/\b(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{12,})\b/gu, '[credential]')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(-6000);

export function assertHostedAndroid(env, platform, arch) {
  requireFact(platform === 'linux' && arch === 'x64' && env.GITHUB_ACTIONS === 'true'
    && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === 'yanghaitao1995/OpenAster',
  'Android acceptance requires this repository on an ephemeral Linux x64 GitHub-hosted runner');
}
export function assertPackagedConfiguration(config, build) {
  requireFact(config?.appId === APK.package && config.server?.hostname === 'localhost'
    && config.server?.androidScheme === 'https' && config.server?.cleartext === false
    && config.android?.allowMixedContent === false && config.android?.webContentsDebuggingEnabled === false,
  'Published APK does not retain the expected HTTPS and WebView isolation configuration');
  requireFact(build?.version === APK.version && build.mode === 'companion' && build.sharedAssets === 27
    && build.sharedAssetsSha256 === APK.sharedAssetsSha256, 'Published APK shared UI does not match the release baseline');
}
function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    requireFact(Number.isInteger(number) && number >= 0 && number <= 0x10ffff, 'Invalid XML character');
    return String.fromCodePoint(number);
  });
}
export function parseHierarchy(xml) {
  requireFact(typeof xml === 'string' && Buffer.byteLength(xml) <= 2 * 1024 * 1024
    && !/<!DOCTYPE|<!ENTITY/iu.test(xml) && /<hierarchy\b/u.test(xml), 'Invalid bounded UI hierarchy');
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/?>/gu)) {
    const node = Object.create(null);
    for (const item of match[1].matchAll(/([a-z-]+)="([^"]*)"/gu)) {
      requireFact(!Object.hasOwn(node, item[1]), 'Duplicate UI attribute'); node[item[1]] = decodeXml(item[2]);
    }
    nodes.push(node); requireFact(nodes.length <= 5000, 'UI hierarchy exceeds node limit');
  }
  requireFact(nodes.length > 0, 'UI hierarchy contains no nodes'); return nodes;
}
export function visibleBounds(node, width = 720, height = 1280) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(node.bounds ?? '');
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return x1 < x2 && y1 < y2 && x1 >= 0 && y1 >= 0 && x2 <= width && y2 <= height
    ? { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) } : null;
}
export function selectControl(nodes, predicate) {
  const matches = nodes.filter(node => node.package === APK.package && node.enabled === 'true'
    && node.clickable === 'true' && visibleBounds(node) && predicate(node));
  requireFact(matches.length === 1, `Expected exactly one visible application control; found ${matches.length}`);
  return { node: matches[0], ...visibleBounds(matches[0]) };
}

async function download(file) {
  let url = new URL(`https://github.com/yanghaitao1995/OpenAster/releases/download/v0.2.2/${APK.file}`);
  const signal = AbortSignal.timeout(120000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    requireFact(url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname), 'Unapproved APK download origin');
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'OpenAster-Android-installer-acceptance', 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location'); await response.body?.cancel();
      requireFact(target && redirects < 5, 'APK redirect limit exceeded'); url = new URL(target, url); continue;
    }
    requireFact(response.status === 200 && response.body, `APK download returned HTTP ${response.status}`);
    const handle = await fs.open(file, 'wx', 0o600); let bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.length; requireFact(bytes <= APK.bytes, 'APK exceeds fixed size'); await handle.writeFile(chunk); } }
    finally { await handle.close(); }
    requireFact(bytes === APK.bytes && await digest(file) === APK.sha256, 'APK hash or size differs; refusing installation');
    return { bytes, sha256: APK.sha256 };
  }
  throw new Error('APK download did not complete');
}

export async function main() {
  assertHostedAndroid(process.env, process.platform, process.arch);
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE);
  const evidence = path.join(workspace, 'android-installer-evidence'); await fs.mkdir(evidence, { recursive: true });
  requireFact(await fs.realpath(evidence) === evidence, 'Evidence path must not resolve through a link');
  const receipt = { format: 'openaster-published-android-acceptance-v1', startedAt: new Date().toISOString(),
    status: 'running', artifact: APK, verificationCommit: process.env.GITHUB_SHA, sourceCommit: '3a4ee6915312dcafd9e56ea5c40440c9b39c5985',
    image: IMAGE, realModelCalls: 0, gatewayTested: false, appModified: false, securitySettingsChanged: false,
    scope: 'Published APK install, launch, offline UI, settings, packaged notices, cleartext gateway refusal and cold relaunch on one API36 x86_64 emulator. Not physical-device, upgrade, signing trust or HTTPS gateway/model acceptance.',
    steps: [], commands: [], services: [], screenshots: [] };
  const save = () => fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  let sequence = 0, temporary, env, adbPath, emulatorPath, serial = 'emulator-5554', avdName, adbService, emulatorService;
  let booted = false, installed = false, lastNodes = [];
  const step = async (name, action) => {
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' }; receipt.steps.push(entry); await save();
    try { const result = await action(); entry.status = 'passed'; entry.result = result; return result; }
    catch (error) { entry.status = 'failed'; entry.error = clean(error.message); throw error; }
    finally { entry.finishedAt = new Date().toISOString(); await save(); }
  };
  async function command(name, executable, args, { timeout = 30000, stdin, binary = false, allowedFailure = false } = {}) {
    const prefix = `${String(++sequence).padStart(3, '0')}-${name}`;
    const record = { name, executable: path.basename(executable), args, startedAt: new Date().toISOString(),
      stdout: `${prefix}.${binary ? 'png' : 'stdout.log'}`, stderr: `${prefix}.stderr.log`, timedOut: false };
    receipt.commands.push(record); const out = [], err = []; let outBytes = 0, errBytes = 0, overflow = false;
    const child = spawn(executable, args, { cwd: temporary, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') record.cleanupError = error.code; } } };
    child.stdout.on('data', bytes => { outBytes += bytes.length; if (outBytes <= 16 * 1024 * 1024) out.push(bytes); else { overflow = true; stop(); } });
    child.stderr.on('data', bytes => { errBytes += bytes.length; if (errBytes <= 2 * 1024 * 1024) err.push(bytes); else { overflow = true; stop(); } });
    child.on('error', error => { record.spawnError = error.code; }); child.stdin.on('error', () => {});
    const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    child.stdin.end(stdin ?? '');
    const timer = setTimeout(() => { record.timedOut = true; stop(); }, timeout);
    Object.assign(record, await exited); clearTimeout(timer); record.finishedAt = new Date().toISOString();
    const output = Buffer.concat(out), errors = Buffer.concat(err);
    await fs.writeFile(path.join(evidence, record.stdout), output); await fs.writeFile(path.join(evidence, record.stderr), errors); await save();
    requireFact(!overflow && !record.timedOut && !record.spawnError && (allowedFailure || record.code === 0),
      `${name} failed (exit ${record.code}, timeout ${record.timedOut}, spawn ${record.spawnError ?? 'none'}); ${clean(errors.toString('utf8'))}`);
    return { ...record, output, text: output.toString('utf8') };
  }
  async function startService(name, executable, args) {
    const stdoutFile = path.join(evidence, `${name}.stdout.log`), stderrFile = path.join(evidence, `${name}.stderr.log`);
    const stdout = await fs.open(stdoutFile, 'wx'), stderr = await fs.open(stderrFile, 'wx');
    const child = spawn(executable, args, { cwd: temporary, env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    const record = { name, pid: child.pid, closed: false }; receipt.services.push(record);
    child.on('error', error => { record.error = error.code; });
    const closed = new Promise(resolve => child.on('close', (code, signal) => { Object.assign(record, { closed: true, code, signal }); resolve(); }));
    await stdout.close(); await stderr.close(); await save(); return { child, record, closed };
  }
  const adb = async (name, args, options) => {
    requireFact(adbService && !adbService.record.closed && !adbService.record.error, 'Owned ADB server is not live; refusing restart');
    return command(name, adbPath, ['-H', '127.0.0.1', '-P', '5038', '-s', serial, ...args], options);
  };
  async function ownedDevice() {
    requireFact(emulatorService && !emulatorService.record.closed && !emulatorService.record.error, 'Owned emulator is not live');
    const result = await adb('verify-owned-avd', ['emu', 'avd', 'name']);
    requireFact(result.text.split(/\r?\n/u).includes(avdName), 'ADB target is not the owned AVD');
  }
  async function capture(name) {
    await ownedDevice();
    const remote = '/data/local/tmp/openaster-acceptance.xml';
    await adb(`${name}-dump`, ['shell', 'uiautomator', 'dump', remote]);
    const xml = await adb(`${name}-hierarchy`, ['exec-out', 'cat', remote]); lastNodes = parseHierarchy(xml.text);
    const png = await adb(`${name}-screen`, ['exec-out', 'screencap', '-p'], { binary: true });
    requireFact(png.output.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid screenshot');
    receipt.screenshots.push(png.stdout); return lastNodes;
  }
  const nodeText = node => `${node.text ?? ''} ${node['content-desc'] ?? ''}`.trim();
  const hasText = pattern => lastNodes.some(node => node.package === APK.package && pattern.test(nodeText(node)));
  async function waitForText(name, pattern) {
    // am start -W confirms the Activity, not completion of the first WebView
    // render. Observe that render instead of treating a fixed sleep as proof.
    for (let attempt = 0; attempt < 6; attempt++) {
      await capture(`${name}-${attempt}`); if (hasText(pattern)) return; await wait(500);
    }
    throw new Error(`Expected application text did not appear: ${name}`);
  }
  async function click(name, pattern, { scroll = false } = {}) {
    for (let attempt = 0; attempt < (scroll ? 7 : 4); attempt++) {
      await capture(`${name}-locate-${attempt}`);
      const candidates = lastNodes.filter(node => node.package === APK.package && node.enabled === 'true' && node.clickable === 'true' && visibleBounds(node) && pattern.test(nodeText(node)));
      if (candidates.length) {
        const selected = selectControl(lastNodes, node => pattern.test(nodeText(node)));
        await adb(name, ['shell', 'input', 'tap', String(selected.x), String(selected.y)]); await wait(400); return;
      }
      if (!scroll) { await wait(400); continue; }
      // A swipe stays inside the previously captured application viewport.
      requireFact(hasText(/模型与连接|Android 开源许可/u), 'Refusing to scroll outside the expected settings view');
      await adb(`${name}-scroll`, ['shell', 'input', 'swipe', '360', '1040', '360', '440', '400']);
    }
    throw new Error(`Visible control was not found: ${name}`);
  }
  async function foreground(name) {
    const activity = await adb(name, ['shell', 'dumpsys', 'activity', 'activities']);
    requireFact(/(?:topResumedActivity|mResumedActivity)[^\n]*org\.openaster\.preview\/\.MainActivity/u.test(activity.text), 'The foreground activity is not OpenAster');
  }
  async function stopService(service) {
    if (!service || !service.child.pid) return;
    const alive = () => { try { process.kill(-service.child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const kill = signal => { try { process.kill(-service.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    if (alive()) {
      kill('SIGTERM'); const graceful = Date.now() + 5000;
      while (alive() && Date.now() < graceful) await wait(100);
      if (alive()) { kill('SIGKILL'); const forced = Date.now() + 5000; while (alive() && Date.now() < forced) await wait(100); }
    }
    await Promise.race([service.closed, wait(1000)]); service.record.processGroupGone = !alive();
    requireFact(service.record.closed && service.record.processGroupGone, 'Owned service cleanup did not complete');
  }
  try {
    await step('isolated-runner-environment', async () => {
      const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP); temporary = await fs.mkdtemp(path.join(runnerTemp, 'openaster-android-'));
      requireFact(within(runnerTemp, temporary), 'Invalid temporary directory');
      const sdk = await fs.realpath(process.env.ANDROID_HOME), java = await fs.realpath(process.env.JAVA_HOME);
      const home = path.join(temporary, 'home'), avds = path.join(temporary, 'avds'); await fs.mkdir(home); await fs.mkdir(avds);
      env = { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8', JAVA_HOME: java,
        ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: path.join(home, '.android'), ANDROID_AVD_HOME: avds,
        ANDROID_EMULATOR_HOME: path.join(home, '.android'), ANDROID_ADB_SERVER_PORT: '5038',
        ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5038', ADB_USB: '0', ADB_MDNS: '0', ADB_MDNS_AUTO_CONNECT: '0' };
      adbPath = path.join(sdk, 'platform-tools', 'adb'); emulatorPath = path.join(sdk, 'emulator', 'emulator');
      avdName = `openaster-acceptance-${randomBytes(8).toString('hex')}`;
      receipt.temporaryDirectory = temporary; return { sdk, java, isolatedHome: true };
    });
    await step('kvm-access-precondition', async () => {
      try {
        await fs.access('/dev/kvm', constants.R_OK | constants.W_OK);
        const result = await command('hardware-acceleration', emulatorPath, ['-accel-check']);
        requireFact(/KVM[^\n]*(installed|usable)|KVM.*version/iu.test(result.text), 'Emulator did not confirm usable KVM'); return { kvmUsable: true };
      } catch (error) {
        receipt.environmentBlocked = true;
        throw new Error(`KVM precondition failed. No permissions or security settings were changed. ${error.code ?? clean(error.message)}`);
      }
    });
    const apkFile = path.join(temporary, APK.file);
    await step('download-published-apk', () => download(apkFile));
    await step('packaged-web-identity-and-policy', async () => {
      const config = await command('packaged-capacitor-config', 'unzip', ['-p', apkFile, 'assets/capacitor.config.json']);
      const build = await command('packaged-shared-ui', 'unzip', ['-p', apkFile, 'assets/public/build-info.json']);
      assertPackagedConfiguration(JSON.parse(config.text), JSON.parse(build.text)); return { version: APK.version, sharedAssetsSha256: APK.sharedAssetsSha256, httpsRequired: true, webViewDebugging: false };
    });
    await step('official-sdk-and-fresh-avd', async () => {
      const bin = path.join(env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin');
      await command('sdk-licenses', path.join(bin, 'sdkmanager'), ['--licenses'], { timeout: 120000, stdin: 'y\n'.repeat(64) });
      await command('sdk-image', path.join(bin, 'sdkmanager'), ['platform-tools', 'emulator', IMAGE], { timeout: 600000, stdin: 'y\n'.repeat(16) });
      await command('emulator-version', emulatorPath, ['-version']); await command('adb-version', adbPath, ['version']);
      await command('create-fresh-avd', path.join(bin, 'avdmanager'), ['create', 'avd', '-n', avdName, '-k', IMAGE, '-p', path.join(temporary, 'avds', `${avdName}.avd`)], { timeout: 90000, stdin: 'no\n' });
      const configFile = path.join(temporary, 'avds', `${avdName}.avd`, 'config.ini');
      const values = new Map((await fs.readFile(configFile, 'utf8')).split(/\r?\n/u).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      for (const [key, value] of Object.entries({ 'hw.ramSize': '3072', 'hw.cpu.ncore': '2', 'hw.lcd.width': '720', 'hw.lcd.height': '1280', 'hw.lcd.density': '320', 'hw.keyboard': 'yes', 'hw.camera.back': 'none', 'hw.camera.front': 'none', 'showDeviceFrame': 'no' })) values.set(key, value);
      await fs.writeFile(configFile, [...values].map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
      return { image: IMAGE, avd: avdName, ramMiB: 3072, device: '720x1280', hardwareAccelerationRequired: true };
    });
    await step('boot-isolated-emulator', async () => {
      for (const port of [5038, 5554, 5555, 8554]) {
        const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); }); await new Promise(resolve => probe.close(resolve));
      }
      adbService = await startService('adb-server', adbPath, ['-L', 'tcp:127.0.0.1:5038', '--one-device', 'openaster-no-usb', 'server', 'nodaemon']); await wait(1000);
      requireFact(!adbService.record.closed && !adbService.record.error, 'Owned ADB did not start');
      emulatorService = await startService('emulator', emulatorPath, ['-avd', avdName, '-port', '5554', '-accel', 'on', '-gpu', 'swiftshader', '-memory', '3072', '-cores', '2', '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-camera-back', 'none', '-camera-front', 'none', '-no-metrics', '-no-direct-adb', '-adb-path', adbPath, '-grpc', '8554', '-grpc-use-jwt']);
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        requireFact(!emulatorService.record.closed && !emulatorService.record.error, 'Emulator exited before boot');
        const check = await adb('boot-progress', ['shell', 'getprop', 'sys.boot_completed'], { allowedFailure: true, timeout: 10000 });
        if (check.code === 0 && check.text.trim() === '1') { booted = true; break; } await wait(2000);
      }
      requireFact(booted, 'Android did not boot within four minutes'); await ownedDevice();
      const selinux = await adb('guest-security', ['shell', 'getenforce']); requireFact(selinux.text.trim() === 'Enforcing', 'Guest SELinux is not enforcing');
      const resolution = await adb('guest-resolution', ['shell', 'wm', 'size']); requireFact(/Physical size: 720x1280/u.test(resolution.text), 'Unexpected guest dimensions');
      const api = await adb('guest-api', ['shell', 'getprop', 'ro.build.version.sdk']); requireFact(api.text.trim() === '36', 'Unexpected Android API');
      await adb('guest-webview', ['shell', 'dumpsys', 'webviewupdate']); return { bootCompleted: true, api: 36, selinux: 'Enforcing' };
    });
    await step('install-and-launch-fixed-apk', async () => {
      await ownedDevice(); requireFact(await digest(apkFile) === APK.sha256, 'APK changed before install');
      const install = await adb('install-published-apk', ['install', '--no-streaming', apkFile], { timeout: 90000 }); requireFact(/\bSuccess\b/u.test(install.text), 'APK installation was not confirmed'); installed = true;
      const info = await adb('installed-version', ['shell', 'dumpsys', 'package', APK.package]);
      requireFact(/versionCode=12\b/u.test(info.text) && /versionName=0\.2\.2\b/u.test(info.text), 'Installed package version differs');
      const result = await adb('launch-published-apk', ['shell', 'am', 'start', '-W', '-n', `${APK.package}/.MainActivity`], { timeout: 45000 });
      requireFact(/Status: ok/u.test(result.text), 'Activity launch was not confirmed'); await waitForText('first-launch', /请先配置 HTTPS 网关/u);
      await foreground('first-launch-foreground');
      return { version: APK.version, versionCode: APK.versionCode, offlinePageRendered: true };
    });
    await step('cleartext-gateway-refusal', async () => {
      await click('open-gateway', /^配置网关$/u); await capture('gateway-dialog'); requireFact(hasText(/连接你的工作台/u), 'Gateway dialog did not open');
      const field = selectControl(lastNodes, node => node.class === 'android.widget.EditText' && node.password === 'false');
      await adb('focus-gateway-url', ['shell', 'input', 'tap', String(field.x), String(field.y)]);
      await adb('enter-cleartext-fixture', ['shell', 'input', 'text', 'http://127.0.0.1:9']);
      const keyboard = await adb('keyboard-state', ['shell', 'dumpsys', 'input_method']);
      // Back can leave the Activity when a hardware keyboard is active. Send
      // it only after Android confirms that the software input view is shown.
      if (/\b(?:mInputShown|inputShown|isInputViewShown)=true\b/u.test(keyboard.text)) await adb('dismiss-keyboard', ['shell', 'input', 'keyevent', '4']);
      await click('submit-cleartext-gateway', /^连接并验证$/u); await capture('cleartext-refused');
      requireFact(hasText(/网关必须使用 HTTPS/u), 'The UI did not reject a cleartext gateway'); await foreground('gateway-refusal-foreground');
      await click('close-gateway', /^(取消|关闭)$/u); return { cleartextRefused: true, syntheticInputOnly: true, accessTokenEntered: false };
    });
    await step('offline-settings-and-license-navigation', async () => {
      await click('open-navigation', /^打开导航$/u); await click('open-settings', /^设置(?:\s|$)/u); await capture('settings');
      requireFact(hasText(/模型与连接/u), 'Settings did not render');
      await click('open-packaged-notices', /^查看开源许可$/u, { scroll: true }); await capture('packaged-notices');
      requireFact(hasText(/^Android 开源许可$/u) && hasText(/Apache-2\.0/u), 'Bundled license inventory did not render');
      await click('expand-apache-license', /^Apache-2\.0(?:\s|·)/u); await capture('license-full-text');
      requireFact(hasText(/Apache License|Version 2\.0/u), 'Apache license full text did not render'); await foreground('license-navigation-foreground');
      await click('close-notices', /^关闭$/u); await click('reopen-navigation', /^打开导航$/u); await click('return-to-task', /^新建任务(?:\s|$)/u); await capture('returned-to-task');
      requireFact(hasText(/请先配置 HTTPS 网关/u), 'Return to offline task page failed'); await foreground('returned-to-task-foreground');
      return { settingsOpened: true, bundledLicenseOpened: true, licenseTextVisible: true, returnedToTask: true, foregroundAppConfirmedAfterLicenseExpansion: true };
    });
    await step('cold-relaunch', async () => {
      await adb('stop-owned-app', ['shell', 'am', 'force-stop', APK.package]);
      const result = await adb('cold-relaunch', ['shell', 'am', 'start', '-W', '-n', `${APK.package}/.MainActivity`], { timeout: 45000 });
      requireFact(/Status: ok/u.test(result.text), 'Cold relaunch was not confirmed'); await waitForText('cold-relaunch', /请先配置 HTTPS 网关/u);
      await foreground('cold-relaunch-foreground'); return { relaunched: true };
    });
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = receipt.environmentBlocked ? 'blocked' : 'failed'; receipt.error = clean(error.message); process.exitCode = 1;
  } finally {
    if (booted && installed && adbService && !adbService.record.closed && emulatorService && !emulatorService.record.closed) {
      try {
        const pid = await adb('app-process', ['shell', 'pidof', APK.package], { allowedFailure: true });
        if (/^\d+$/u.test(pid.text.trim())) {
          const errors = await adb('app-error-logcat', ['logcat', '--pid', pid.text.trim(), '-d', '-v', 'threadtime', '*:E']);
          if (/FATAL EXCEPTION|Fatal signal \d+/u.test(errors.text)) { receipt.status = 'failed'; receipt.error = 'Fatal app error was recorded in logcat'; process.exitCode = 1; }
        }
      } catch (error) { receipt.diagnosticError = clean(error.message); }
    }
    for (const service of [emulatorService, adbService]) {
      try { await stopService(service); }
      catch (error) { receipt.status = 'failed'; receipt.cleanupError = clean(error.message); process.exitCode = 1; }
    }
    receipt.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: receipt.status, error: receipt.error, steps: receipt.steps.map(({ name, status, error }) => ({ name, status, error })), evidence }));
    if (receipt.status !== 'passed') {
      for (const file of ['emulator.stderr.log', 'adb-server.stderr.log']) {
        try { const bytes = await fs.readFile(path.join(evidence, file)); console.log(JSON.stringify({ log: file, tail: clean(bytes.subarray(-8000).toString('utf8')) })); } catch { /* A precondition may fail before service creation. */ }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
