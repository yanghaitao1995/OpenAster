import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['web-tools-ui.e2e.spec.mjs','workspace-management.e2e.spec.mjs','harness-ui.e2e.spec.mjs','android-notices.e2e.spec.mjs','command-approval.e2e.spec.mjs','command-policy-ui.e2e.spec.mjs','task-input-ui.e2e.spec.mjs','markdown.e2e.spec.mjs','session-list.e2e.spec.mjs','theme-appearance.e2e.spec.mjs','manual-file-edit.e2e.spec.mjs','device-drafts.e2e.spec.mjs','composer-drafts-storage.e2e.spec.mjs','composer-refresh.e2e.spec.mjs','page-resume.e2e.spec.mjs','e2e.spec.mjs','accessibility.spec.mjs','accessibility-interactions.e2e.spec.mjs','streaming.e2e.spec.mjs','usage.e2e.spec.mjs','usage-overview.e2e.spec.mjs','capabilities.e2e.spec.mjs','workspace-context.e2e.spec.mjs','workspace-browse.e2e.spec.mjs','workspace-index.e2e.spec.mjs','lazy-workspace.e2e.spec.mjs','workspace-search.e2e.mjs','workspace-ignore.e2e.spec.mjs','file-edit.e2e.spec.mjs','run-history.e2e.spec.mjs','context-files.e2e.spec.mjs','context-planner.e2e.spec.mjs','conversation-branch.e2e.spec.mjs','composer.e2e.spec.mjs','provider-diagnostics.e2e.spec.mjs','conversation-handoff.e2e.spec.mjs','summary-draft.e2e.spec.mjs'], timeout: 45000, expect: {timeout:12000}, fullyParallel:false, workers:1,
  reporter:[['list'],['html',{outputFolder:'test-results/browser-report',open:'never'}]],
  outputDir:'test-results/playwright',
  use:{baseURL:'http://127.0.0.1:4318',viewport:{width:1440,height:960},headless:true,channel:process.platform==='win32'?'msedge':undefined,trace:'retain-on-failure',screenshot:'only-on-failure',video:'off'},
  globalSetup:'./scripts/test-server.mjs'
});

