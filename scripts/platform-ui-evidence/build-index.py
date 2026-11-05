"""Index actual browser frames, preserving provenance and all failure attempts."""
import argparse
from collections import Counter, defaultdict
from hashlib import sha256
from html import escape
import json
from pathlib import Path
import subprocess

ROOT = Path("docs/design/platform-unification-2026-11-05")
RUNTIME = ROOT / "runtime"


def read(path):
    return json.loads(path.read_text())


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def reviews():
    result = defaultdict(list)
    for path in sorted((RUNTIME / "reviews").glob("*.json")):
        report = read(path)
        if not isinstance(report, dict):
            continue  # Contact-sheet manifests are inventories, not review verdicts.
        for row in report.get("rows", []) + report.get("entries", []) + report.get("images", []) + report.get("actualAfterImages", []):
            if any(row.get(key) is False for key in ["actuallyViewed", "actuallyViewedThisPass", "primaryViewed", "viewedByIndependentReviewer"]):
                continue
            checksum = row.get("sha256") or (row.get("primary") or {}).get("actualSha256")
            verdict = row.get("verdict") or row.get("visualComparison") or row.get("status")
            if checksum and verdict:
                result[checksum].append({"report": str(path.relative_to(RUNTIME)), "verdict": verdict,
                    "observation": row.get("observation") or row.get("observed") or row.get("visualObservation")})
    return result


def source_relationship(commit, changed, row):
    if not changed:
        return "same application tree"
    # Explicit component-level equivalence for the final narrow patches. Keep
    # anything touching these surfaces as historical until it has a newer frame.
    scene = row["sceneId"]
    if git_is_old[commit]:
        return "historical application"
    changed = set(changed)
    catalog_files = {'plugins/mcp/manifest.json','plugins/git/manifest.json'}
    ids = set(row.get('sourceIds', []))
    if changed & catalog_files and (scene in ('plugin-catalog','settings-plugins','plugin-uninstall') or ids & {'ST-047','ST-048','ST-049','ST-050','ST-051','ST-052','ST-053','ST-054'}):
        return 'earlier plugin catalog versions; scoped layout reference only'
    short_footer_only = ('apps/web/components/BlogWorkspace.vue' not in changed and
                         'apps/web/components/blog/BlogDesignStudio.vue' not in changed and
                         bool(changed & {'apps/web/blog-savebar.ts','apps/web/blog-admin.css'}))
    if short_footer_only and (row.get('viewport',{}).get('height',0) >= 800 or
        not (scene.startswith('blog-design') or scene == 'blog-settings' or
             (scene.startswith('blog-feedback-') and 'article' not in scene) or
             scene in ('public-blog-history-restore','public-blog-expanded-preview'))):
        # The final short-viewport patch only changes the savebar owned by the
        # settings and design forms. Taller view evidence is bound by the final
        # three-width rendering/interaction checks. Preserve its original SHA.
        changed -= {'apps/web/blog-savebar.ts','apps/web/blog-admin.css'}
    affected = (
        ("Setup", ("setup",)), ("GitRemotePanel", ("git-", "cloud-sync", "history-git")),
        ("PluginManager", ("plugin-catalog", "plugin-config", "settings-plugins", "mcp-config")),
        ("PublicShareEditor", ("guest-",)), ("Blog", ("blog-",)), ("blog-", ("blog-",)),
        ("MarkdownEditor", ("source", "selection", "editor", "paragraph")),
        ("Workspace.vue", ("unfinished", "new-whiteboard", "new-mindmap", "new-flowchart")),
        ("DiagramSaveDialog", ("diagram-close",)), ("DraftRecovery", ("draft-recovery",)),
        ("mindmap", ("mindmap",)), ("opaque-source", ("opaque",)),
        ("whiteboards/", ("whiteboard", "vendor-", "embedded-primary", "diagram-save", "diagram-close")),
    )
    if any(any(pattern in path for path in changed) and any(part in scene for part in parts)
           for pattern, parts in affected):
        return "historical affected component"
    return "component-equivalent under scoped changes"


def html_index(selected, coverage):
    titles = {row["sourceId"]: row["title"] for row in coverage}
    groups = defaultdict(list)
    for entry in selected:
        groups[entry["sceneId"]].append(entry)
    sections = []
    for scene, entries in sorted(groups.items()):
        cards = []
        for entry in entries:
            url = escape(entry["png"], quote=True)
            label = escape(entry["id"] + " · " + entry["sourceCommit"][:7])
            info = escape(" / ".join(item["verdict"] for item in entry["review"]) or "尚无逐图复核记录")
            cards.append(f'<figure><a href="{url}"><img loading="lazy" src="{url}" alt="{label}"></a><figcaption>{label}<br>{info}</figcaption></figure>')
        names = " / ".join(titles.get(key, key) for key in entries[0]["sourceIds"])
        heading = escape(" · ".join([names, scene, ", ".join(entries[0]["sourceIds"])]))
        sections.append(f'<details><summary>{heading} ({len(entries)})</summary><div class="grid">{"".join(cards)}</div></details>')
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>非 ToDoo 平台实际界面</title>
<style>body{margin:2rem auto;padding:0 1rem;max-width:92rem;font:16px/1.6 system-ui;color:#223047}details{padding:.5rem 0;border-bottom:1px solid #ccd3df}summary{cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(17rem,100%),1fr));gap:.8rem}figure{margin:0}img{width:100%;height:15rem;object-fit:contain;background:#f3f5f9}figcaption{font-size:.85rem}input{font:inherit;padding:.3rem;width:min(25rem,90%)}a{color:#384fa4}</style>
<h1>非 ToDoo 平台实际界面</h1><p>每个场景可展开，点击图片查看原图。宽度、版本和审阅结论分别列出。历史画面与未核实状态见<a href="effective-index.json">完整实测索引</a>。</p><label>查找场景或来源编号 <input id="filter" type="search"></label>""" + "".join(sections) + """<script>document.querySelector('#filter').oninput=e=>{for(const d of document.querySelectorAll('details'))d.hidden=!d.querySelector('summary').textContent.toLowerCase().includes(e.target.value.toLowerCase())}</script></html>"""


parser = argparse.ArgumentParser()
parser.add_argument("--application-commit", required=True)
args = parser.parse_args()
canonical = git("rev-parse", args.application_commit)
references = reviews()
invalid = {(e["runId"], e["evidenceId"]) for e in read(RUNTIME / "historical-state-exclusions.json")["entries"]}
attempts, candidates, runs, differences, git_is_old = [], defaultdict(list), [], {}, {}
application = ["apps", "packages", "plugins", "shared", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "tsconfig.server.json"]

for metadata in sorted(RUNTIME.glob("*/run.json")):
    run = read(metadata)
    if "sourceCommit" not in run or "applicationFingerprint" not in run:
        continue
    directory = metadata.parent
    if not directory.joinpath("summary.json").exists():
        receipt = {"runStatus": "partial with no final receipt"}
    else:
        receipt = read(directory / "summary.json")
    counts = Counter()
    for path in sorted(directory.glob("*.json")):
        if not path.name.startswith(("1440-", "390-", "320-", "360-", "820-", "844-")) or path.name.endswith(("-progress.json", "-diagnostic.json")):
            continue
        row = read(path)
        if not row.get("sceneId") or not row.get("status"):
            continue
        counts[row["status"]] += 1
        attempts.append({"run": directory.name, "id": row["id"], "status": row["status"],
            "record": str(path.relative_to(RUNTIME)), "probe": row.get("probeStatus")})
        if row["status"] != "captured" or (row.get("runId"), row["id"]) in invalid:
            continue
        png = directory / row["file"]
        if digest(png) != row["sha256"]:
            raise ValueError(f"PNG mismatch: {png}")
        commit = row["sourceCommit"]
        if commit not in differences:
            differences[commit] = git("diff", "--name-only", commit, canonical, "--", *application).splitlines()
            git_is_old[commit] = subprocess.run(["git", "merge-base", "--is-ancestor", "55174d4", commit], check=False).returncode != 0 and subprocess.run(["git","merge-base","--is-ancestor","6b93769",commit],check=False).returncode != 0
        relation = source_relationship(commit, differences[commit], row)
        # A broad page screenshot never proves content in closed or offscreen children.
        entry = {k: row.get(k) for k in ["id","sceneId","suite","title","state","role","sourceIds","theme","viewport","sourceCommit","applicationFingerprint","sha256","targetBounds","targetWithinViewport","probeStatus","interactionResult","faultInjection","renderedTheme","readinessAssertions","failureControlIndices","outerOverflow"]}
        shot = row.get("controlsScreenshot")
        if shot and shot.get("file"):
            control = directory / shot["file"]
            if digest(control) != shot["sha256"]:
                raise ValueError(f"Controls PNG mismatch: {control}")
            entry["controlsScreenshot"] = {"png": str(control.relative_to(RUNTIME)), "sha256": shot["sha256"]}
        entry.update({"run": directory.name, "record": str(path.relative_to(RUNTIME)), "png": str(png.relative_to(RUNTIME)),
            "relationship": relation, "review": references[row["sha256"]],
            "designs": [{"assetId": d.get("assetId"), "png": (d.get("current") or {}).get("file"),
                         "sha256": (d.get("current") or {}).get("sha256")} for d in row.get("designAssets", [])], "capturedAt": run["startedAt"]})
        candidates[row["id"]].append(entry)
    runs.append({"run": directory.name, "sourceCommit":run["sourceCommit"], "status": receipt.get("runStatus", receipt.get("status")), "counts":dict(counts)})
selected = []
for key, entries in sorted(candidates.items()):
    entries.sort(key=lambda e: e["capturedAt"])
    selected.append(entries[-1])
catalog=read(ROOT/"design/catalog.json")
dormant = {record["sourceId"] for record in catalog["coverage"] if record.get("dormant")}
coverage=[]
for inventory in ["workspace","settings","public-and-blog","runtime-diagrams"]:
    for surface in read(ROOT/f"coverage/{inventory}.json")["surfaces"]:
        linked=[e for e in selected if surface["id"] in e["sourceIds"]]
        coverage.append({"sourceId":surface["id"], "title":surface["title"], "inventory":inventory,
            "importantStates":surface.get("importantStates",[]), "selectedFrameIds":[e["id"] for e in linked],
            "status": ("visible-family-evidence" if linked else "dormant-unmounted" if surface["id"] in dormant
                       else "conditional-source-only" if surface["id"] == "PB-016"
                       else "nonvisual HTTP" if surface["id"] == "PB-060" else "no eligible visual capture")})
result={"schema":1,"applicationCommit":canonical,"approvedDesignDigest":catalog["coverageDigest"],
    "policy":"Latest actual captured image per scene and viewport after explicit invalidations. Version relationships derive from scoped component changes. Theme is the requested browser setting. Actual rendered theme is reported independently where measured; login/public chrome and published light blogs can stay light in a dark context. Each verdict concerns only what its image shows. Each faultInjection field identifies simulated failures, latency and fixture-supplied read models. Those rows demonstrate the rendered UI and cannot establish live business outcomes. Attempts include failures, unavailable states and incomplete runs. OS picker, native share delivery, physical keyboard, actual printing and external delivery are unverified.",
    "equivalenceBoundary": {"wholeApp":"same application tree requires zero differences across the tracked app fingerprint inputs",
        "workspace":"post-551 Workspace changes are restricted to the unfinished-creation form and operation ownership; whiteboard popovers, initial mind-map fit, diagram recovery and opaque markup each have separate captures",
        "theme":"post-551 global platform-ui.css change is the editor selection token; document-editor.css affects selection and opaque-card danger controls",
        "settings":"setup, Git feedback, and plugin configuration are separately rendered. Earlier plugin version labels are historical; an actual rc61-to-current click-through separately checks before/after labels",
        "blog":"final short-viewport behavior is local to measured settings/design savebars; regression samples at tall 1440/390/320 and short 360/844 are separately bound to their actual commits",
        "images":"a matched family or geometry is not equivalent to successful network delivery, all controls, identical pixels or a different role/state"},
    "applicationFilesChangedByCapturedCommit":differences,"runs":runs,"sources":coverage,"attempts":attempts,"frames":selected}
dump(RUNTIME/"effective-index.json",result)
(RUNTIME/"index.html").write_text(html_index(selected, coverage))
print(json.dumps({"frames":len(selected),"attempts":len(attempts),"runs":len(runs),"sources":len(coverage),"relationships":dict(Counter(e["relationship"] for e in selected))}))
