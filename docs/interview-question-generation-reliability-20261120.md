# Interview Question Generation Reliability

Date: 2026-11-20. Scope: interview questions, not fixed human-scored assessment rubrics.

## Evidence And Limits

- The retained runtime log contains a question-preparation failure at
  2026-11-20T08:27:42.891Z, but replaces its diagnostic object with
  '[structured log omitted]'. A subsequent manual retry succeeded.
- Successful retry clears the mutable preparation failure fields. The precise
  reason for that historical failure cannot be recovered from these records.
- Regression tests reproduced a concrete failure: two individually valid
  five-question responses can contain a cross-batch duplicate. Previously the
  final merge rejected the entire group outside the correction loop.
- The full-bank generator had the same issue across role groups. Correction
  requests also lacked the rejected output and referred to the entire group
  rather than explicitly to the current batch.

## Changes

- Check duplicates against accepted questions inside the current request's
  validation/correction boundary. Keep the final whole-result validation.
- Send accepted questions from other groups separately from the batch offset,
  so avoiding cross-group duplicates does not change AI batch pagination.
- Include the rejected output in correction context only when at most 16,000
  characters; keep it in memory, never in errors or logs. Request only the
  current batch and keep successful batches/groups during correction.
- Preserve the existing single correction attempt, shared timeout, cancellation,
  HTTP retry policy, billing identity and uncertain-result safeguards.
- Serialize only the existing sanitized preparation diagnostics as a string,
  which the managed runtime logger persists. Do not serialize arbitrary errors,
  candidate materials, model output or credentials.

## Verification

- New regressions failed before the implementation changes and pass afterward.
- Combined generator, preparation, assessment-sheet, background-close, managed
  runtime and log-persistence tests: 237 passed, none failed or skipped.
- API production build and strict typechecking of the two changed TS test
  entrypoints passed.
- Full API test build reports pre-existing TS2339 errors in
  apps/api/tests/configurable-billing.postgres.integration.test.ts at lines 44
  and 157. These unrelated tests were not edited.
- No paid model requests or changes to candidate/question records were made.

## Deployment Status

Source and local compiled API artifacts are updated. No runtime release was
modified or activated. The active-release pointer still names
business-20261120-candidate-batch-delete-r10. A read-only status check found all
three managed processes stopped; the controller records an external normal
stop at 2026-11-20T08:42:08.194Z. This investigation did not stop or start them.
Publish only these changes in a reviewed immutable release; do not bundle the
workspace's unrelated pending edits or patch the sealed active release.
