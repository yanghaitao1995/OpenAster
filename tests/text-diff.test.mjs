import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTextDiff, DIFF_LIMITS } from '../public/text-diff.mjs';

test('line diff keeps exact additions, deletions and independent line numbers', () => {
  const result = buildTextDiff('first\nold\nlast\n', 'first\nnew\nextra\nlast\n');
  assert.equal(result.mode, 'diff'); assert.equal(result.added, 2); assert.equal(result.removed, 1);
  assert.deepEqual(result.rows.map(({kind,oldLine,newLine,text})=>[kind,oldLine,newLine,text]), [['context',1,1,'first'],['remove',2,null,'old'],['add',null,2,'new'],['add',null,3,'extra'],['context',3,4,'last']]);
});
test('new, empty and identical documents have truthful existence and change information', () => {
  assert.equal(buildTextDiff(null, '').changed, true); assert.equal(buildTextDiff(null, '').summary.before.exists, false);
  assert.equal(buildTextDiff('', '').changed, false); assert.equal(buildTextDiff('', '').summary.after.lines, 0);
  assert.equal(buildTextDiff(null, 'new').added, 1); assert.equal(buildTextDiff('old', '').removed, 1);
});
test('BOM, mixed newline kinds and missing terminal newline are represented explicitly', () => {
  const result = buildTextDiff('\uFEFFalpha\r\nbeta\nlast\r', 'alpha\nbeta\r\nlast');
  assert.equal(result.summary.before.bom, true); assert.equal(result.summary.after.bom, false);
  assert.deepEqual(result.summary.before.endings, {LF:1,CRLF:1,CR:1}); assert.equal(result.summary.before.finalEnding, 'CR'); assert.equal(result.summary.after.finalEnding, null);
  assert.deepEqual(result.rows.map(row=>row.ending), ['CRLF','LF','CR','LF','CRLF',null]);
  const bomOnly=buildTextDiff('\uFEFFa\n','a\n');assert.equal(bomOnly.changed,true);assert.equal(bomOnly.added,0);assert.equal(bomOnly.removed,0);
});
test('sparse changes in long documents retain correct context with explicit omitted lines', () => {
  const before=Array.from({length:4000},(_,i)=>'line '+i+'\n').join('');const after=before.replace('line 2000\n','changed\n');
  const result=buildTextDiff(before,after);assert.equal(result.mode,'diff');assert.equal(result.rows.length,10);assert.equal(result.rows[0].kind,'gap');assert.equal(result.rows.at(-1).kind,'gap');assert.equal(result.rows.find(row=>row.kind==='remove').oldLine,2001);
});
test('all hard budgets fail closed to a complete-view fallback with no partial patch', () => {
  for(const [before,after,reason] of [['','你'.repeat(90000),'bytes'],['','\n'.repeat(10001),'lines'],['','x'.repeat(4001),'long-line'],[('old\n').repeat(800),('new\n').repeat(800),'matrix'],['',('new\n').repeat(501),'display']]) {
    const result=buildTextDiff(before,after);assert.equal(result.mode,'fallback');assert.equal(result.reason,reason);assert.deepEqual(result.rows,[]);assert.equal(result.added,null);
  }
  assert.equal(Object.isFrozen(DIFF_LIMITS),true);
});
test('repeated-line tie breaking is deterministic and strings remain inert data', () => {
  const before='a\nb\na\n',after='a\na\nb\n<script>throw 1</script>';
  assert.deepEqual(buildTextDiff(before,after),buildTextDiff(before,after));assert.ok(buildTextDiff(before,after).rows.some(row=>row.text==='<script>throw 1</script>'));
});
test('bounded line diffs reconstruct exact text including Unicode and line endings', () => {
  let seed=713;const next=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};const tokens=['甲\n','乙\r\n','🙂\r','\n','same\n'];
  for(let trial=0;trial<120;trial++){
    const make=()=>Array.from({length:next()%12},()=>tokens[next()%tokens.length]).join('')+(next()%2?'tail':'');
    const before=make(),after=make(),result=buildTextDiff(before,after);assert.equal(result.mode,'diff');
    // With <=12 lines there can still be a context gap; only compare uncollapsed runs.
    if(result.rows.some(row=>row.kind==='gap')||!result.changed)continue;
    const restore=kind=>result.rows.filter(row=>row.kind!==kind).map(row=>row.text+({LF:'\n',CRLF:'\r\n',CR:'\r'}[row.ending]||'')).join('');
    assert.equal(restore('add'),before);assert.equal(restore('remove'),after);
  }
});
