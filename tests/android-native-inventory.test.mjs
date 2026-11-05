import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const candidates = [process.env.OPENASTER_PYTHON, existsSync(bundled) && bundled, 'python3', 'python'].filter(Boolean);
const python = candidates.find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

test('offline Android inventory validates closure, evidence, and unsafe or inconsistent inputs', { skip: !python }, () => {
  const result = spawnSync(python, ['-B', '-', path.join(root, 'scripts/android-native-inventory.py')], {
    cwd: root,
    encoding: 'utf8',
    input: String.raw`
import importlib.util, io, json, pathlib, subprocess, sys, tempfile, unittest, zipfile
from xml.sax.saxutils import escape
spec = importlib.util.spec_from_file_location('inventory', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def zipped(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        for name, content in entries.items(): archive.writestr(name, content)
    return data.getvalue()

class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.model = self.root / 'model'
        self.model.mkdir()
        self.jar = self.cache / 'example' / 'runtime' / '1.0.0' / 'abc' / 'runtime-1.0.0.jar'
        self.jar.parent.mkdir(parents=True)
        self.jar.write_bytes(zipped({'example/Runtime.class': b'class', 'META-INF/LICENSE': b'Example license\r\n'}))
        self.pom = self.jar.with_suffix('.pom')
        self.pom.write_text('<project><groupId>example</groupId><artifactId>runtime</artifactId><version>1.0.0</version><licenses><license><name>Example License</name><url>https://example.invalid/license</url></license></licenses></project>')
        self.deps = self.model / 'debug-artifact-dependencies.xml'
        self.deps.write_text('<dependencies><compile roots="example:runtime:1.0.0@jar,example:compile:1.0.0@jar"><dependency name="example:runtime:1.0.0@jar"/><dependency name="example:compile:1.0.0@jar"/></compile><package roots="example:runtime:1.0.0@jar"><dependency name="example:runtime:1.0.0@jar"/></package></dependencies>')
        self.libs = self.model / 'debug-artifact-libraries.xml'
        self.write_libs(self.jar)
        self.variant = self.model / 'debug.xml'
        self.variant.write_text('<variant name="debug"><artifact type="MAIN"/></variant>')
        self.apk = self.root / 'app.apk'
        self.apk.write_bytes(zipped({'classes.dex': b'dex', 'META-INF/example_runtime.version': b'1.0.0'}))
        self.receipt = self.root / 'receipt.json'
        self.receipt.write_text(json.dumps({'sha256':m.sha(self.apk.read_bytes()),'bytes':self.apk.stat().st_size,'versionName':'1.0.0','versionCode':1}))

    def write_libs(self, jar, resolved='example:runtime:1.0.0'):
        self.libs.write_text('<libraries><library name="example:runtime:1.0.0@jar" resolved="'+resolved+'" jars="'+escape(str(jar), {'"':'&quot;'})+'"/><library name="example:compile:1.0.0@jar" resolved="example:compile:1.0.0" jars="unused.jar"/></libraries>')

    def generate(self, receipt=True):
        return m.generate(self.root,self.apk,self.deps,self.libs,self.cache,self.receipt if receipt else None)

    def cli(self, output, *extra):
        return subprocess.run([sys.executable,'-B',m.__file__,'--root',str(self.root),'--apk',str(self.apk),
            '--dependencies',str(self.deps),'--libraries',str(self.libs),'--cache',str(self.cache),
            '--receipt',str(self.receipt),'--output',str(output),*extra],capture_output=True,text=True)

    def test_package_only_and_evidence(self):
        (self.cache / 'unused-build-tool.jar').write_bytes(b'unrelated cache entry')
        report,payloads = self.generate()
        self.assertEqual(report['counts'], {'runtimeComponents':1,'maven':1,'localProjects':0})
        self.assertEqual(report['compileOnly'], ['example:compile:1.0.0@jar'])
        self.assertEqual(report['apk']['sha256'],m.sha(self.apk.read_bytes()))
        self.assertEqual(len(report['metadataEvidence']),4)
        component = report['components'][0]
        self.assertEqual(component['declaredLicenses'][0]['name'],'Example License')
        notice = component['notices'][0]
        self.assertEqual(payloads[notice['sha256']],b'Example license\r\n')

    def test_dtd_rejected(self):
        self.pom.write_text('<!DOCTYPE project [<!ENTITY injected "fake">]><project/>')
        with self.assertRaisesRegex(m.InventoryError,'DTD/entity'): self.generate()

    def test_incomplete_mapping_rejected(self):
        self.libs.write_text('<libraries/>')
        with self.assertRaisesRegex(m.InventoryError,'Incomplete library'): self.generate()

    def test_external_artifact_rejected(self):
        self.write_libs(self.root.parent / 'outside.jar')
        with self.assertRaisesRegex(m.InventoryError,'outside project root'): self.generate()

    def test_library_version_mismatch_rejected(self):
        self.write_libs(self.jar,'example:runtime:2.0.0')
        with self.assertRaisesRegex(m.InventoryError,'version mismatch'): self.generate()

    def test_apk_version_mismatch_rejected(self):
        self.apk.write_bytes(zipped({'META-INF/example_runtime.version':b'9.0.0'}))
        with self.assertRaisesRegex(m.InventoryError,'version marker mismatch'): self.generate(False)

    def test_receipt_mismatch_rejected(self):
        self.apk.write_bytes(zipped({'classes.dex':b'changed'}))
        with self.assertRaisesRegex(m.InventoryError,'receipt hash/size'): self.generate()

    def test_test_variant_rejected(self):
        self.variant.write_text('<variant name="debug"><artifact type="UNIT_TEST"/></variant>')
        with self.assertRaisesRegex(m.InventoryError,'MAIN variant'): self.generate()

    def test_parent_license_is_resolved_locally(self):
        self.pom.write_text('<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent><artifactId>runtime</artifactId></project>')
        parent = self.cache/'example'/'parent'/'1.0.0'/'abc'/'parent-1.0.0.pom'
        parent.parent.mkdir(parents=True)
        parent.write_text('<project><groupId>example</groupId><artifactId>parent</artifactId><version>1.0.0</version><licenses><license><name>Inherited License</name></license></licenses></project>')
        report,_ = self.generate()
        self.assertEqual(report['components'][0]['declaredLicenses'][0]['name'],'Inherited License')
        self.assertEqual(len(report['components'][0]['pomEvidence']),2)

    def test_unreadable_pom_is_an_explicit_gap(self):
        self.pom.write_bytes(b'\xffbinary')
        report,_ = self.generate()
        self.assertTrue(any(g['code']=='pom_unreadable_by_reader' for g in report['coverageGaps']))
        self.assertEqual(report['components'][0]['declaredLicenses'],[])

    def test_empty_license_declarations_are_gaps(self):
        for licenses in ('<licenses/>','<licenses><license/></licenses>','<licenses><license><name>  </name><url> </url></license></licenses>'):
            with self.subTest(licenses=licenses):
                self.pom.write_text('<project><groupId>example</groupId><artifactId>runtime</artifactId><version>1.0.0</version>'+licenses+'</project>')
                report,_ = self.generate()
                self.assertEqual(report['components'][0]['declaredLicenses'],[])
                self.assertTrue(any(g['code']=='license_declaration_empty' for g in report['coverageGaps']))

    def test_cli_creates_new_report_and_preserves_existing_files(self):
        output = self.root / 'report.json'
        notices = self.root / 'notices'
        first = self.cli(output,'--extract-notices',str(notices))
        self.assertEqual(first.returncode,0,first.stderr)
        original = output.read_bytes()
        extracted = next(notices.iterdir())
        before = (extracted.read_bytes(),extracted.stat().st_mtime_ns)
        repeated = self.cli(output,'--extract-notices',str(notices))
        self.assertNotEqual(repeated.returncode,0)
        self.assertIn('already exists',repeated.stderr)
        self.assertEqual(output.read_bytes(),original)
        second = self.cli(self.root/'report2.json','--extract-notices',str(notices))
        self.assertEqual(second.returncode,0,second.stderr)
        self.assertEqual((extracted.read_bytes(),extracted.stat().st_mtime_ns),before)

    def test_cli_cannot_overwrite_apk(self):
        before = self.apk.read_bytes()
        result = self.cli(self.apk)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.apk.read_bytes(),before)

unittest.main(argv=['inventory-tests'], verbosity=2)
`,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
