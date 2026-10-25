"""One counterparty archive, independently tracked matters, shared person identities."""
from __future__ import annotations
import hashlib
import re
from pathlib import Path
import yaml

MATTER_README = re.compile(r"counterparties/[^/]+/matters/[^/]+/README\.md")
PARTY_README = re.compile(r"counterparties/[^/]+/README\.md")
LEGACY_README = re.compile(r"projects/[^/]+/README\.md")
FRONTMATTER = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)


def is_attachment_path(relative):
    parts = Path(relative).parts
    return len(parts) >= 3 and parts[0] in {"counterparties", "projects"} and parts[2] == "attachments"


def archive_only_project(directory):
    children = list(directory.iterdir())
    return bool(children) and all(child.name in {"attachments", ".DS_Store"} for child in children) and (directory / "attachments").is_dir()


def frontmatter(source):
    match = FRONTMATTER.match(source)
    if not match:
        raise ValueError("文档缺少资料信息。")
    return yaml.safe_load(match[1]), source[match.end():]


def document(metadata, body=""):
    return "---\n" + yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False, width=1000) + "---\n" + body


def counterparties(files):
    result = {}
    for name, source in files.items():
        if PARTY_README.fullmatch(name):
            try:
                metadata, body = frontmatter(source)
                result[metadata["id"]] = (Path(name).parent.as_posix(), metadata, body)
            except (ValueError, KeyError, TypeError, yaml.YAMLError):
                continue
    return result


def name_key(name):
    return re.sub(r"\s+", " ", name.strip()).casefold()


def valid_folder(name):
    return isinstance(name, str) and bool(name.strip()) and name == name.strip() and name not in {".", ".."} and not name.startswith(".") and not re.search(r"[/\\\x00-\x1f]", name) and len(name.encode("utf-8")) <= 180


def party_id(name):
    return "counterparty-" + hashlib.sha256(name_key(name).encode()).hexdigest()[:16]


def migrate_files(files, preferred=None):
    """Project the old layout into the new layout; also used to read old Git versions.

    Existing IDs, matter facts, contact roles, events and meeting bytes are preserved.
    Names in the old counterparties list create references, never new business matters.
    """
    legacy = {}
    for name, source in sorted(files.items()):
        if LEGACY_README.fullmatch(name):
            metadata, body = frontmatter(source)
            legacy[metadata["id"]] = (Path(name).parent.as_posix(), metadata, body)
    if not legacy:
        return dict(files), {}, {}
    if any(MATTER_README.fullmatch(name) for name in files):
        raise ValueError("资料目录结构不一致，请由维护人员整理后再编辑。")
    result = dict(files)
    people = {person["id"] for person in (yaml.safe_load(files.get("people.yaml", "people: []")) or {}).get("people", [])}
    # Prefer existing canonical locations when comparing or restoring an old snapshot.
    preferred = preferred or {}
    preferred_matters = {}
    for name, source in preferred.items():
        if MATTER_README.fullmatch(name):
            try:
                meta, _ = frontmatter(source)
                preferred_matters[meta["id"]] = (Path(name).parent.as_posix(), meta)
            except (ValueError, KeyError, TypeError, yaml.YAMLError):
                pass
    preferred_parties = counterparties(preferred)
    preferred_by_name = {name_key(meta["name"]): (directory, meta) for directory, meta, _ in preferred_parties.values()}
    primary_folders = {}
    for old, metadata, _ in legacy.values():
        primary_folders.setdefault(name_key(metadata["counterparties"][0]), Path(old).name)
    parties, used_directories, paths, archives = {}, set(), {}, {}
    for identity, (old, metadata, body) in legacy.items():
        ids = []
        for name in metadata["counterparties"]:
            key = name_key(name)
            if key not in parties:
                existing = preferred_by_name.get(key)
                folder = primary_folders.get(key, name)
                if not valid_folder(folder):
                    raise ValueError("对接方名称不能安全用作目录，请先修正名称。")
                meta = {"id": party_id(name), "name": name, "kind": "person" if name in people else "organization"}
                directory = "counterparties/" + folder
                if existing:
                    directory, previous = existing
                    meta = {**previous, "name": name}
                if directory in used_directories:
                    directory += "-" + meta["id"][-8:]
                used_directories.add(directory)
                parties[key] = (directory, meta)
                result[directory + "/README.md"] = document(meta, "\n# " + name + "\n")
                result[directory + "/contacts.yaml"] = yaml.safe_dump({"counterparty": meta["id"], "people": []}, allow_unicode=True, sort_keys=False)
            ids.append(parties[key][1]["id"])
        home, party = parties[name_key(metadata["counterparties"][0])]
        matter_name = {"investment": "融资对接", "cooperation": "合作对接", "resource": "资源对接"}[metadata["record_type"]]
        target = home + "/matters/" + matter_name
        if identity in preferred_matters and preferred_matters[identity][1].get("primary_counterparty_id") == ids[0]:
            target = preferred_matters[identity][0]
        if target in paths.values():
            target += "-" + identity[-8:]
        paths[old] = target
        archives[old + "/attachments"] = home + "/attachments"
        updated = {key: value for key, value in metadata.items() if key != "counterparties"}
        updated.update(primary_counterparty_id=ids[0], counterparty_ids=list(dict.fromkeys(ids)))
        for name, source in files.items():
            if name.startswith(old + "/") and not is_attachment_path(name):
                result.pop(name)
                result[target + name[len(old):]] = document(updated, body) if name == old + "/README.md" else source
    if "files.yaml" in result:
        index = yaml.safe_load(result["files.yaml"])
        for item in index.get("files", []):
            old_home = item.pop("home_project_id", None)
            if old_home:
                item["home_counterparty_id"] = frontmatter(result[paths[legacy[old_home][0]] + "/README.md"])[0]["primary_counterparty_id"]
            for entry in item.get("versions", []) + item.get("records", []):
                for old, new in archives.items():
                    if entry.get("archive_path", "").startswith(old + "/"):
                        entry["archive_path"] = new + entry["archive_path"][len(old):]
                        break
        result["files.yaml"] = yaml.safe_dump(index, allow_unicode=True, sort_keys=False, width=1000)
    # Rewrite local Markdown links only when relocating changes their relative target.
    import posixpath
    for old, target in paths.items():
        for old_name, old_source in files.items():
            if not old_name.startswith(old + "/") or not old_name.endswith(".md"):
                continue
            new_name = target + old_name[len(old):]
            def link(match):
                raw = match.group(1)
                if re.match(r"(?:[a-z]+:|#|/)", raw):
                    return match.group(0)
                url, sep, anchor = raw.partition("#")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(old_name), url))
                for before, after in paths.items():
                    if resolved == before or resolved.startswith(before + "/"):
                        resolved = after + resolved[len(before):]
                        break
                updated_url = posixpath.relpath(resolved, posixpath.dirname(new_name))
                return "](" + updated_url + (sep + anchor if sep else "") + ")"
            result[new_name] = re.sub(r"\]\(([^<>\s)]+)\)", link, result[new_name])
    return result, paths, archives
