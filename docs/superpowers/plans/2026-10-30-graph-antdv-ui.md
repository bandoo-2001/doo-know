# Graph Ant Design Vue UI implementation

User feedback explicitly requests replacing the graph's inconsistent native/custom controls with the installed Ant Design Vue framework. Keep the existing graph backend, data, APIs, source navigation and request model behavior.

- Root: use Ant Segmented/Input.Search/Dropdown/Form/Select/Checkbox/Switch/Slider/InputNumber/Progress/Card/List/Alert/Empty in the workspace. Reduce primary actions and use the existing Ant theme; remove native control CSS.
- Inspector worker: convert forms, entity management and provenance cards to Ant Form/Input/Select/Collapse/Tag/Card while preserving editable predicate state and events.
- Overlay worker: graph-specific Ant Modal/Drawer wrapper with busy/dirty close guards and accessible titles, leaving the shared Naive settings wrapper untouched.
- Root: adapt browser interaction helpers to real Ant controls, verify dirty model input, desktop/mobile full workflow, themes and visual consistency. Run relevant workbench/API tests, typecheck and production build; independent UI review and local commit.

Work remains in the existing clean `codex/knowledge-graph` worktree at base `c9b08ee`. No new dependency installation, production deployment or edits to other sessions.
