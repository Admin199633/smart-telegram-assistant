Execute tasks from TASK.md with strict minimal scope.

Rules:

* Work on ONE task only
* Do NOT explore unrelated files
* Do NOT refactor beyond task scope

For the current task:

1. Identify minimal files
2. Implement smallest fix
3. Validate behavior logically (or with minimal tests)
4. Update WORKLOG.md:

   * Root cause
   * Fix
   * Files changed
5. Remove completed task from TASK.md

After finishing all tasks in a block:

* Remove the block
* Move to next block

Critical constraints:

* Prefer fixing existing logic over adding new layers
* Fix root cause, not symptoms
* Ensure behavior matches real Hebrew input (not reversed text)

Start:
Open TASK.md
Execute ONLY the first task in BLOCK 1
