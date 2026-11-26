# Resume Upload Unlock Fix (Pending Activation)

## Deployment Status

This patch has NOT been applied to the running frontend. The user has active
resume uploads and interviews. Do not apply it until those sessions are safe
to refresh. No API, worker, database or interview changes are required.

Applying this patch while Vite is running can hot-reload the candidate page and
abort uploads on that page. No service restart is needed in the current Vite
setup, but existing pages may need a refresh after a safe activation window.

## Evidence

- Read-only database inspection on October 26, 2026 found the displayed
  `30842af1-30c3-42f8-bd1b-bf5dd48d274c` batch completed, its single upload queued,
  and its analysis task completed. Do not upload that document again.
- The frontend awaited both a full candidate-list refresh and a batch read
  before clearing `creatingCandidate`.
- A stalled request at either boundary left the close button, completion
  button and other entry points disabled despite successful upload.
- Three new regression tests failed against the original page and passed
  after the fix. The precise request stalled in the user's browser was not
  inspected, so the frontend defect is reproduced, not a network diagnosis.

## Changes

- Clear upload activity when the upload queue finishes, independently of
  candidate-list and batch-status refreshes.
- Continue status reads separately; keep their errors distinct from upload
  errors and preserve already accepted uploads.
- Allow hiding and reopening the upload dialog without cancelling uploads.
- Display an explicit submitted state rather than an apparently active upload
  command when every file has already been accepted.
- Ignore stale batch responses after changing batches or leaving the page,
  and avoid replacing in-flight upload entries during polling.

Hiding the dialog does not cancel uploads while the candidate page stays
mounted. Leaving that route or closing the browser can still abort unfinished
uploads. This patch does not claim browser-independent background uploads.

## Activation

After all active uploads and interviews are safe to refresh, from the repository
root, check the patch before applying it. Do not force it if the check fails.

```powershell
git apply --check docs/patches/resume-upload-unlock-20261026.patch
git apply docs/patches/resume-upload-unlock-20261026.patch
```

The patch touches only:

- `web/src/modules/candidates/pages/CandidateListPage.vue`
- `web/src/modules/candidates/pages/CandidateListPage.batch-upload.test.ts`

It does not include the pre-existing changes to API routes or API tests.

## Verification

Verified in `tmp/resume-upload-unlock-20261026/web`, a copy of the frontend
outside the live Vite root, using existing installed dependencies. No test
issued real upload, analysis, cancellation or interview requests.

- 27 tests passed: candidate page (14), batch upload (10), upload queue (3).
- `vue-tsc --noEmit` passed against the isolated frontend.
- Pending list request, pending batch read, failed progress refresh, and
  hiding/reopening an active upload are covered.
- The generated patch passed `git apply --check` against the current source.

The patch must still be applied in a safe window and checked in the browser.
