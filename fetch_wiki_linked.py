#!/usr/bin/env python3
"""Resumable MediaWiki Action API scraper for The Backrooms Wiki (Fandom).

Fetches all non-redirect standard pages (namespace=0), their primary wikitext,
and linked File: images, then stores Markdown pages, local image files,
index_linked.json, and manifest.json under the target dataset directory.

All retrieved wiki content and metadata are attributed under CC-BY-SA-3.0.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from requests.adapters import HTTPAdapter

API_URL = "https://backrooms.fandom.com/api.php"
WIKI_NAME = "Backrooms Wiki (Fandom)"
WIKI_URL = "https://backrooms.fandom.com/wiki/Backrooms_Wiki"
WIKI_BASE_URL = "https://backrooms.fandom.com/wiki/"
LICENSE_NAME = "CC-BY-SA-3.0"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/3.0/"
USER_AGENT = "BackroomsWikiResearchPipeline/1.0 (CC-BY-SA-3.0; educational 3D prototype)"

BATCH_SIZE = 50
DEFAULT_WORKERS = 8
DEFAULT_MAX_FILE_MB = 20
REQUEST_TIMEOUT_SEC = 25
MAX_RETRIES = 4
RETRY_STATUS_CODES = {429, 500, 502, 503, 504}

PRIORITY_CORE_TITLES = [
    "Level 0",
    "Level 1",
    "Level 2",
    "The Hub",
    "Object 1",
    "Object 2",
    "Entity List",
]

MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "image/tiff": ".tif",
}

_thread_local = threading.local()


def utc_now_iso() -> str:
    """Return current UTC timestamp in ISO-8601 format."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_session() -> requests.Session:
    """Create a pooled HTTP session with the pipeline User-Agent."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    adapter = HTTPAdapter(pool_connections=16, pool_maxsize=16)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def get_thread_session() -> requests.Session:
    """Return a thread-local requests.Session for concurrent downloads."""
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = make_session()
        _thread_local.session = session
    return session


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Atomically write raw bytes to path via a temporary sibling file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def atomic_write_text(path: Path, text: str) -> None:
    """Atomically write UTF-8 text to path."""
    atomic_write_bytes(path, text.encode("utf-8"))


def atomic_write_json(path: Path, obj: Any) -> None:
    """Atomically write formatted UTF-8 JSON to path."""
    atomic_write_text(path, json.dumps(obj, indent=2, ensure_ascii=False))


def load_json_if_valid(path: Path) -> Any | None:
    """Load JSON file if it exists and parses cleanly; otherwise return None."""
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[warn] Ignoring corrupted cache {path.name}: {exc}", flush=True)
        return None


def wiki_page_url(title: str) -> str:
    """Construct canonical Fandom wiki URL for a page title."""
    slug = title.replace(" ", "_")
    return WIKI_BASE_URL + urllib.parse.quote(slug, safe="/:()'!*,")


def safe_page_filename(title: str, pageid: int) -> str:
    """Build deterministic collision-free filename for a Markdown wiki page."""
    slug = re.sub(r"[^A-Za-z0-9]+", "_", title)
    slug = re.sub(r"_+", "_", slug).strip("._")
    if not slug:
        slug = "page"
    slug = slug[:90].rstrip("_") or "page"
    return f"{slug}__{pageid}.md"


def safe_image_filename(file_title: str, mime: str | None) -> str:
    """Build deterministic filesystem-safe filename preserving extension and hash."""
    raw_name = file_title[5:] if file_title.startswith("File:") else file_title
    stem, orig_ext = os.path.splitext(raw_name)
    orig_ext_low = orig_ext.lower()
    mime_low = (mime or "").split(";")[0].strip().lower()

    if mime_low in MIME_TO_EXT:
        # Keep .jpeg if orig was .jpeg and mime is image/jpeg, else use canonical ext
        ext = ".jpeg" if (mime_low == "image/jpeg" and orig_ext_low == ".jpeg") else MIME_TO_EXT[mime_low]
    elif re.fullmatch(r"\.[a-z0-9]{1,5}", orig_ext_low):
        ext = orig_ext_low
    else:
        ext = ".bin"

    clean_stem = re.sub(r"[^A-Za-z0-9]+", "_", stem)
    clean_stem = re.sub(r"_+", "_", clean_stem).strip("._")
    if not clean_stem:
        clean_stem = "img"
    clean_stem = clean_stem[:70].rstrip("_") or "img"

    short_hash = hashlib.sha1(file_title.encode("utf-8")).hexdigest()[:10]
    return f"{clean_stem}__{short_hash}{ext}"


def request_with_retry(
    session: requests.Session,
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: int = REQUEST_TIMEOUT_SEC,
    max_retries: int = MAX_RETRIES,
) -> requests.Response:
    """Perform HTTP request with exponential backoff and Retry-After support."""
    last_exc: Exception | None = None
    last_resp: requests.Response | None = None

    for attempt in range(max_retries):
        try:
            resp = session.request(method, url, params=params, timeout=timeout)
            if resp.status_code not in RETRY_STATUS_CODES:
                return resp
            last_resp = resp
            retry_after = resp.headers.get("Retry-After")
            delay = (2**attempt) + random.uniform(0.1, 0.6)
            if retry_after:
                try:
                    delay = max(delay, float(retry_after))
                except ValueError:
                    pass
            if attempt < max_retries - 1:
                time.sleep(min(delay, 30.0))
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < max_retries - 1:
                delay = (2**attempt) + random.uniform(0.1, 0.6)
                time.sleep(min(delay, 30.0))

    if last_resp is not None:
        return last_resp
    assert last_exc is not None
    raise last_exc


def api_query(session: requests.Session, params: dict[str, Any]) -> dict[str, Any]:
    """Execute a MediaWiki Action API query returning parsed JSON."""
    full_params = dict(params)
    full_params.setdefault("action", "query")
    full_params.setdefault("format", "json")
    resp = request_with_retry(session, "GET", API_URL, params=full_params)
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"MediaWiki API error: {data['error']}")
    return data


def yaml_quote(value: str) -> str:
    """Escape string as a double-quoted YAML scalar."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def render_page_markdown(page_meta: dict[str, Any], wikitext: str) -> str:
    """Format a wiki page with YAML frontmatter, CC-BY-SA-3.0 notice, and wikitext."""
    images: list[str] = page_meta.get("images", [])
    lines = [
        "---",
        f"pageid: {page_meta['pageid']}",
        f"title: {yaml_quote(page_meta['title'])}",
        f"source_url: {yaml_quote(page_meta['url'])}",
        f"revid: {page_meta.get('revid') if page_meta.get('revid') is not None else 'null'}",
        f"timestamp: {yaml_quote(page_meta.get('timestamp') or '')}",
        f"license: {yaml_quote(LICENSE_NAME)}",
        f"license_url: {yaml_quote(LICENSE_URL)}",
        f"image_count: {len(images)}",
    ]
    if images:
        lines.append("images:")
        for img in images:
            lines.append(f"  - {yaml_quote(img)}")
    else:
        lines.append("images: []")
    lines.extend([
        "---",
        "",
        f"# {page_meta['title']}",
        "",
        (
            f"> Source: [{WIKI_NAME}]({page_meta['url']}) | "
            f"License: [{LICENSE_NAME}]({LICENSE_URL})"
        ),
        "",
        "## Wikitext",
        "",
        wikitext.rstrip("\n"),
        "",
    ])
    return "\n".join(lines)


def phase1_fetch_all_pages(
    session: requests.Session,
    cache_path: Path,
    refresh: bool,
) -> list[dict[str, Any]]:
    """Phase 1: Enumerate all non-redirect namespace=0 pages."""
    if not refresh:
        cached = load_json_if_valid(cache_path)
        if isinstance(cached, list) and len(cached) > 0:
            print(
                f"[Phase 1] Reusing cached allpages list: {len(cached)} pages ({cache_path.name})",
                flush=True,
            )
            return cached

    print("[Phase 1] Querying all non-redirect namespace=0 pages from MediaWiki API...", flush=True)
    pages: list[dict[str, Any]] = []
    params: dict[str, Any] = {
        "action": "query",
        "list": "allpages",
        "apnamespace": 0,
        "apfilterredir": "nonredirects",
        "aplimit": 500,
        "format": "json",
    }
    while True:
        data = api_query(session, params)
        batch = data.get("query", {}).get("allpages", [])
        for p in batch:
            pages.append({
                "pageid": int(p["pageid"]),
                "ns": int(p["ns"]),
                "title": str(p["title"]),
            })
        if "continue" in data:
            params.update(data["continue"])
        else:
            break

    # Deduplicate by pageid just in case wiki moved a page during iteration
    seen: set[int] = set()
    unique_pages: list[dict[str, Any]] = []
    for p in pages:
        if p["pageid"] not in seen:
            seen.add(p["pageid"])
            unique_pages.append(p)

    atomic_write_json(cache_path, unique_pages)
    print(f"[Phase 1] Enumerated {len(unique_pages)} pages.", flush=True)
    return unique_pages


def fetch_batch_revisions(
    session: requests.Session,
    pageids: list[int],
) -> dict[int, dict[str, Any]]:
    """Query wikitext revisions for up to 50 pageids."""
    result: dict[int, dict[str, Any]] = {}
    params = {
        "action": "query",
        "pageids": "|".join(str(pid) for pid in pageids),
        "prop": "revisions",
        "rvprop": "content|ids|timestamp",
        "rvslots": "main",
        "format": "json",
        "formatversion": 2,
    }
    data = api_query(session, params)
    for p in data.get("query", {}).get("pages", []):
        pid = int(p["pageid"])
        if p.get("missing"):
            continue
        revs = p.get("revisions", [])
        rev = revs[0] if revs else {}
        content = rev.get("slots", {}).get("main", {}).get("content", "")
        result[pid] = {
            "pageid": pid,
            "title": str(p.get("title", "")),
            "revid": rev.get("revid"),
            "timestamp": rev.get("timestamp", ""),
            "content": content,
        }
    return result


def fetch_batch_images(
    session: requests.Session,
    pageids: list[int],
) -> dict[int, list[str]]:
    """Query ALL linked File: images for up to 50 pageids, following every continue."""
    images_by_pid: dict[int, list[str]] = {pid: [] for pid in pageids}
    seen_by_pid: dict[int, set[str]] = {pid: set() for pid in pageids}

    params: dict[str, Any] = {
        "action": "query",
        "pageids": "|".join(str(pid) for pid in pageids),
        "prop": "images",
        "imlimit": "max",
        "format": "json",
        "formatversion": 2,
    }
    while True:
        data = api_query(session, params)
        for p in data.get("query", {}).get("pages", []):
            pid = int(p["pageid"])
            if pid not in images_by_pid:
                images_by_pid[pid] = []
                seen_by_pid[pid] = set()
            for im in p.get("images", []):
                title = str(im.get("title", ""))
                if title and title not in seen_by_pid[pid]:
                    seen_by_pid[pid].add(title)
                    images_by_pid[pid].append(title)
        if "continue" in data:
            params.update(data["continue"])
        else:
            break
    return images_by_pid


def phase2_fetch_pages_and_links(
    session: requests.Session,
    all_pages: list[dict[str, Any]],
    pages_dir: Path,
    cache_meta_path: Path,
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Phase 2: Fetch wikitext + linked images separately, saving Markdown per page."""
    pages_dir.mkdir(parents=True, exist_ok=True)
    cached_meta = load_json_if_valid(cache_meta_path)
    meta_by_pid: dict[str, dict[str, Any]] = (
        cached_meta if isinstance(cached_meta, dict) else {}
    )

    to_fetch: list[dict[str, Any]] = []
    reused_count = 0
    for p in all_pages:
        pid_str = str(p["pageid"])
        existing = meta_by_pid.get(pid_str)
        if existing and existing.get("markdown_path"):
            md_full = pages_dir.parent / existing["markdown_path"]
            if md_full.exists() and md_full.stat().st_size > 0 and "images" in existing:
                reused_count += 1
                continue
        to_fetch.append(p)

    print(
        f"[Phase 2] Reusing {reused_count} cached pages; fetching {len(to_fetch)} remaining pages...",
        flush=True,
    )

    failed_pages: list[dict[str, Any]] = []
    fetched_now = 0

    for batch_idx in range(0, len(to_fetch), BATCH_SIZE):
        batch = to_fetch[batch_idx : batch_idx + BATCH_SIZE]
        batch_pids = [p["pageid"] for p in batch]
        batch_titles = {p["pageid"]: p["title"] for p in batch}

        try:
            revs = fetch_batch_revisions(session, batch_pids)
            imgs = fetch_batch_images(session, batch_pids)
        except Exception as exc:
            print(
                f"[Phase 2][warn] Batch {batch_idx // BATCH_SIZE + 1} failed ({exc}); retrying per page...",
                flush=True,
            )
            revs = {}
            imgs = {}
            for pid in batch_pids:
                try:
                    revs.update(fetch_batch_revisions(session, [pid]))
                    imgs.update(fetch_batch_images(session, [pid]))
                except Exception as inner_exc:
                    failed_pages.append({
                        "pageid": pid,
                        "title": batch_titles[pid],
                        "error": str(inner_exc),
                    })

        for pid in batch_pids:
            if pid not in revs:
                if not any(fp["pageid"] == pid for fp in failed_pages):
                    failed_pages.append({
                        "pageid": pid,
                        "title": batch_titles[pid],
                        "error": "missing_revision",
                    })
                continue

            rev_info = revs[pid]
            title = rev_info["title"] or batch_titles[pid]
            md_filename = safe_page_filename(title, pid)
            rel_md_path = f"pages/{md_filename}"
            page_meta = {
                "pageid": pid,
                "title": title,
                "url": wiki_page_url(title),
                "revid": rev_info["revid"],
                "timestamp": rev_info["timestamp"],
                "markdown_path": rel_md_path,
                "images": imgs.get(pid, []),
            }
            md_text = render_page_markdown(page_meta, rev_info["content"])
            atomic_write_text(pages_dir / md_filename, md_text)
            meta_by_pid[str(pid)] = page_meta
            fetched_now += 1

        if (batch_idx // BATCH_SIZE + 1) % 5 == 0 or (batch_idx + BATCH_SIZE >= len(to_fetch)):
            atomic_write_json(cache_meta_path, meta_by_pid)
            print(
                f"[Phase 2] Progress: {reused_count + fetched_now}/{len(all_pages)} pages saved.",
                flush=True,
            )

    if to_fetch:
        atomic_write_json(cache_meta_path, meta_by_pid)
    return meta_by_pid, failed_pages


def phase3_resolve_imageinfo(
    session: requests.Session,
    meta_by_pid: dict[str, dict[str, Any]],
    cache_imageinfo_path: Path,
) -> dict[str, dict[str, Any]]:
    """Phase 3: Resolve imageinfo metadata for all unique referenced File: titles."""
    unique_titles_set: set[str] = set()
    for p in meta_by_pid.values():
        for file_title in p.get("images", []):
            unique_titles_set.add(file_title)

    unique_titles = sorted(unique_titles_set)
    cached = load_json_if_valid(cache_imageinfo_path)
    imageinfo_map: dict[str, dict[str, Any]] = cached if isinstance(cached, dict) else {}

    missing_titles = [t for t in unique_titles if t not in imageinfo_map]
    print(
        f"[Phase 3] Unique File: refs={len(unique_titles)}, cached={len(unique_titles) - len(missing_titles)}, querying={len(missing_titles)}...",
        flush=True,
    )

    for idx in range(0, len(missing_titles), BATCH_SIZE):
        batch = missing_titles[idx : idx + BATCH_SIZE]
        try:
            data = api_query(
                session,
                {
                    "action": "query",
                    "titles": "|".join(batch),
                    "prop": "imageinfo",
                    "iiprop": "url|size|mime|sha1",
                    "format": "json",
                    "formatversion": 2,
                },
            )
            norm_map: dict[str, str] = {}
            for n in data.get("query", {}).get("normalized", []):
                norm_map[str(n["from"])] = str(n["to"])

            by_canonical: dict[str, dict[str, Any]] = {}
            for p in data.get("query", {}).get("pages", []):
                canonical_title = str(p.get("title", ""))
                ii_list = p.get("imageinfo", [])
                if p.get("missing") or not ii_list:
                    by_canonical[canonical_title] = {
                        "canonical_title": canonical_title,
                        "found": False,
                    }
                else:
                    ii = ii_list[0]
                    by_canonical[canonical_title] = {
                        "canonical_title": canonical_title,
                        "found": True,
                        "url": ii.get("url", ""),
                        "description_url": ii.get("descriptionurl", wiki_page_url(canonical_title)),
                        "mime": ii.get("mime", ""),
                        "size": ii.get("size", 0),
                        "width": ii.get("width", 0),
                        "height": ii.get("height", 0),
                        "sha1": ii.get("sha1", ""),
                    }

            for orig_title in batch:
                canon = norm_map.get(orig_title, orig_title)
                entry = by_canonical.get(canon)
                if entry is None:
                    entry = {"canonical_title": canon, "found": False}
                imageinfo_map[orig_title] = entry
        except Exception as exc:
            print(f"[Phase 3][warn] imageinfo batch failed ({exc}); retrying individual titles...", flush=True)
            for orig_title in batch:
                try:
                    data = api_query(
                        session,
                        {
                            "action": "query",
                            "titles": orig_title,
                            "prop": "imageinfo",
                            "iiprop": "url|size|mime|sha1",
                            "format": "json",
                            "formatversion": 2,
                        },
                    )
                    pages = data.get("query", {}).get("pages", [])
                    p = pages[0] if pages else {}
                    ii_list = p.get("imageinfo", [])
                    if not ii_list or p.get("missing"):
                        imageinfo_map[orig_title] = {"canonical_title": orig_title, "found": False}
                    else:
                        ii = ii_list[0]
                        imageinfo_map[orig_title] = {
                            "canonical_title": str(p.get("title", orig_title)),
                            "found": True,
                            "url": ii.get("url", ""),
                            "description_url": ii.get("descriptionurl", wiki_page_url(orig_title)),
                            "mime": ii.get("mime", ""),
                            "size": ii.get("size", 0),
                            "width": ii.get("width", 0),
                            "height": ii.get("height", 0),
                            "sha1": ii.get("sha1", ""),
                        }
                except Exception:
                    imageinfo_map[orig_title] = {"canonical_title": orig_title, "found": False}

        if (idx // BATCH_SIZE + 1) % 10 == 0 or (idx + BATCH_SIZE >= len(missing_titles)):
            atomic_write_json(cache_imageinfo_path, imageinfo_map)

    if missing_titles:
        atomic_write_json(cache_imageinfo_path, imageinfo_map)
    return imageinfo_map


def with_original_format(url: str) -> str:
    """Append format=original for static.wikia.nocookie.net so CDN preserves JPEG/PNG bytes."""
    if "static.wikia.nocookie.net" not in url or "format=original" in url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}format=original"


def download_one_image(
    file_title: str,
    info: dict[str, Any],
    images_dir: Path,
    local_filename: str,
) -> dict[str, Any]:
    """Download a single image with format=original preference and fallback."""
    dest_path = images_dir / local_filename
    if dest_path.exists() and dest_path.stat().st_size > 0:
        return {
            "file_title": file_title,
            "status": "downloaded",
            "reused": True,
            "local_path": f"images/{local_filename}",
            "bytes": dest_path.stat().st_size,
        }

    session = get_thread_session()
    raw_url = str(info["url"])
    primary_url = with_original_format(raw_url)
    candidate_urls = [primary_url] if primary_url == raw_url else [primary_url, raw_url]

    last_status: str = "failed_unknown"
    for candidate_url in candidate_urls:
        try:
            resp = request_with_retry(session, "GET", candidate_url, timeout=30)
            if resp.status_code == 200 and len(resp.content) > 0:
                atomic_write_bytes(dest_path, resp.content)
                return {
                    "file_title": file_title,
                    "status": "downloaded",
                    "reused": False,
                    "local_path": f"images/{local_filename}",
                    "bytes": len(resp.content),
                }
            last_status = f"failed_http_{resp.status_code}"
        except Exception as exc:
            last_status = f"failed_error:{type(exc).__name__}"

    return {
        "file_title": file_title,
        "status": last_status,
        "reused": False,
        "local_path": None,
        "bytes": 0,
    }


def phase4_download_images(
    meta_by_pid: dict[str, dict[str, Any]],
    imageinfo_map: dict[str, dict[str, Any]],
    images_dir: Path,
    workers: int,
    max_file_bytes: int,
) -> dict[str, dict[str, Any]]:
    """Phase 4: Download linked image/* assets concurrently with resume and priority order."""
    images_dir.mkdir(parents=True, exist_ok=True)

    # Identify priority core files so Level 0/1/2/Hub assets download first
    priority_files: set[str] = set()
    for p in meta_by_pid.values():
        if p.get("title") in PRIORITY_CORE_TITLES:
            priority_files.update(p.get("images", []))

    all_referenced: set[str] = set()
    for p in meta_by_pid.values():
        all_referenced.update(p.get("images", []))

    download_results: dict[str, dict[str, Any]] = {}
    to_download: list[tuple[str, dict[str, Any], str]] = []

    for file_title in sorted(all_referenced):
        info = imageinfo_map.get(file_title, {"found": False})
        if not info.get("found") or not info.get("url"):
            download_results[file_title] = {
                "file_title": file_title,
                "status": "missing_imageinfo",
                "reused": False,
                "local_path": None,
                "bytes": 0,
            }
            continue

        mime = str(info.get("mime", ""))
        if not mime.lower().startswith("image/"):
            download_results[file_title] = {
                "file_title": file_title,
                "status": "skipped_non_image",
                "reused": False,
                "local_path": None,
                "bytes": 0,
            }
            continue

        size = int(info.get("size") or 0)
        if size > max_file_bytes:
            download_results[file_title] = {
                "file_title": file_title,
                "status": "skipped_too_large",
                "reused": False,
                "local_path": None,
                "bytes": 0,
            }
            continue

        filename = safe_image_filename(file_title, mime)
        dest = images_dir / filename
        if dest.exists() and dest.stat().st_size > 0:
            download_results[file_title] = {
                "file_title": file_title,
                "status": "downloaded",
                "reused": True,
                "local_path": f"images/{filename}",
                "bytes": dest.stat().st_size,
            }
        else:
            to_download.append((file_title, info, filename))

    # Sort so priority core images are queued first
    to_download.sort(key=lambda item: (0 if item[0] in priority_files else 1, item[0]))

    reused_imgs = sum(1 for r in download_results.values() if r["reused"])
    print(
        f"[Phase 4] Total referenced={len(all_referenced)}, reused={reused_imgs}, "
        f"non-image/missing/oversize={len(download_results) - reused_imgs}, to_download={len(to_download)}",
        flush=True,
    )

    if to_download:
        done = 0
        total = len(to_download)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(download_one_image, ft, info, images_dir, fname): ft
                for ft, info, fname in to_download
            }
            for fut in as_completed(futures):
                ft = futures[fut]
                try:
                    res = fut.result()
                except Exception as exc:
                    res = {
                        "file_title": ft,
                        "status": f"failed_error:{type(exc).__name__}",
                        "reused": False,
                        "local_path": None,
                        "bytes": 0,
                    }
                download_results[ft] = res
                done += 1
                if done % 250 == 0 or done == total:
                    ok_now = sum(1 for r in download_results.values() if r["status"] == "downloaded")
                    print(
                        f"[Phase 4] Downloaded {done}/{total} queued (total available images={ok_now})",
                        flush=True,
                    )

    return download_results


def phase5_write_outputs(
    output_dir: Path,
    all_pages: list[dict[str, Any]],
    meta_by_pid: dict[str, dict[str, Any]],
    imageinfo_map: dict[str, dict[str, Any]],
    download_results: dict[str, dict[str, Any]],
    failed_pages: list[dict[str, Any]],
    started_at: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Phase 5: Write index_linked.json and manifest.json."""
    sorted_pages = sorted(
        meta_by_pid.values(),
        key=lambda p: (str(p.get("title", "")).lower(), int(p["pageid"])),
    )

    linked_pages: list[dict[str, Any]] = []
    core_pages_verified: dict[str, Any] = {}

    for p in sorted_pages:
        linked_images: list[dict[str, Any]] = []
        for file_title in p.get("images", []):
            ii = imageinfo_map.get(file_title, {})
            dl = download_results.get(file_title, {})
            linked_images.append({
                "file_title": file_title,
                "local_path": dl.get("local_path"),
                "url": ii.get("url") or None,
                "description_url": ii.get("description_url") or wiki_page_url(file_title),
                "mime": ii.get("mime") or None,
                "size": ii.get("size") or 0,
                "width": ii.get("width") or 0,
                "height": ii.get("height") or 0,
                "sha1": ii.get("sha1") or None,
                "status": dl.get("status", "unknown"),
            })

        entry = {
            "pageid": int(p["pageid"]),
            "title": p["title"],
            "url": p["url"],
            "revid": p.get("revid"),
            "timestamp": p.get("timestamp", ""),
            "markdown_path": p["markdown_path"],
            "images": linked_images,
        }
        linked_pages.append(entry)

        if p["title"] in PRIORITY_CORE_TITLES:
            core_pages_verified[p["title"]] = {
                "pageid": entry["pageid"],
                "markdown_path": entry["markdown_path"],
                "image_count": len(linked_images),
                "downloaded_count": sum(1 for im in linked_images if im["status"] == "downloaded"),
                "images": [
                    {
                        "file_title": im["file_title"],
                        "local_path": im["local_path"],
                        "status": im["status"],
                    }
                    for im in linked_images
                ],
            }

    unique_downloaded = sum(
        1 for r in download_results.values() if r["status"] == "downloaded"
    )
    unique_reused = sum(
        1 for r in download_results.values() if r["status"] == "downloaded" and r["reused"]
    )
    skipped_non_image = sum(
        1 for r in download_results.values() if r["status"] == "skipped_non_image"
    )
    skipped_too_large = sum(
        1 for r in download_results.values() if r["status"] == "skipped_too_large"
    )
    missing_imageinfo = sum(
        1 for r in download_results.values() if r["status"] == "missing_imageinfo"
    )
    failed_imgs_list = [
        {"file_title": r["file_title"], "status": r["status"]}
        for r in download_results.values()
        if r["status"].startswith("failed_")
    ]

    completed_at = utc_now_iso()

    index_linked = {
        "schema_version": "1.0.0",
        "wiki": WIKI_NAME,
        "wiki_url": WIKI_URL,
        "api_url": API_URL,
        "license": LICENSE_NAME,
        "license_url": LICENSE_URL,
        "generated_at": completed_at,
        "page_count": len(linked_pages),
        "unique_file_count": len(download_results),
        "downloaded_image_count": unique_downloaded,
        "pages": linked_pages,
    }

    manifest = {
        "schema_version": "1.0.0",
        "wiki": WIKI_NAME,
        "wiki_url": WIKI_URL,
        "api_url": API_URL,
        "license": LICENSE_NAME,
        "license_url": LICENSE_URL,
        "source_attribution": (
            f"All textual content and linked media metadata are retrieved from "
            f"{WIKI_NAME} ({WIKI_URL}) and distributed under {LICENSE_NAME} ({LICENSE_URL})."
        ),
        "started_at": started_at,
        "completed_at": completed_at,
        "resume_enabled": True,
        "counts": {
            "total_pages_listed": len(all_pages),
            "pages_fetched": len(linked_pages),
            "pages_failed": len(failed_pages),
            "unique_files_referenced": len(download_results),
            "image_files_eligible": unique_downloaded + len(failed_imgs_list),
            "images_downloaded": unique_downloaded,
            "images_reused": unique_reused,
            "images_skipped_non_image": skipped_non_image,
            "images_skipped_too_large": skipped_too_large,
            "images_missing_imageinfo": missing_imageinfo,
            "images_failed": len(failed_imgs_list),
        },
        "core_pages_verified": core_pages_verified,
        "failed_pages": failed_pages,
        "failed_images": failed_imgs_list[:200],
        "paths": {
            "pages_dir": "pages",
            "images_dir": "images",
            "index_linked": "index_linked.json",
            "manifest": "manifest.json",
        },
    }

    atomic_write_json(output_dir / "index_linked.json", index_linked)
    atomic_write_json(output_dir / "manifest.json", manifest)
    print(
        f"[Phase 5] Wrote index_linked.json ({len(linked_pages)} pages) and manifest.json "
        f"(downloaded images={unique_downloaded}, failed={len(failed_imgs_list)}).",
        flush=True,
    )
    return index_linked, manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Resumable MediaWiki Action API scraper for The Backrooms Wiki."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("/content/work_br_wiki/dataset"),
        help="Target dataset output directory (default: /content/work_br_wiki/dataset)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Concurrent image download workers (default: {DEFAULT_WORKERS})",
    )
    parser.add_argument(
        "--refresh-list",
        action="store_true",
        help="Force refresh of allpages enumeration cache.",
    )
    parser.add_argument(
        "--max-file-mb",
        type=int,
        default=DEFAULT_MAX_FILE_MB,
        help=f"Maximum individual image size in MB (default: {DEFAULT_MAX_FILE_MB})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started_at = utc_now_iso()
    output_dir: Path = args.output_dir.resolve()
    pages_dir = output_dir / "pages"
    images_dir = output_dir / "images"
    output_dir.mkdir(parents=True, exist_ok=True)

    cache_allpages = output_dir / ".cache_allpages.json"
    cache_pages_meta = output_dir / ".cache_pages_meta.json"
    cache_imageinfo = output_dir / ".cache_imageinfo.json"

    session = make_session()

    all_pages = phase1_fetch_all_pages(session, cache_allpages, args.refresh_list)
    meta_by_pid, failed_pages = phase2_fetch_pages_and_links(
        session, all_pages, pages_dir, cache_pages_meta
    )
    imageinfo_map = phase3_resolve_imageinfo(session, meta_by_pid, cache_imageinfo)
    download_results = phase4_download_images(
        meta_by_pid,
        imageinfo_map,
        images_dir,
        workers=max(1, args.workers),
        max_file_bytes=max(1, args.max_file_mb) * 1024 * 1024,
    )
    _, manifest = phase5_write_outputs(
        output_dir,
        all_pages,
        meta_by_pid,
        imageinfo_map,
        download_results,
        failed_pages,
        started_at,
    )

    counts = manifest["counts"]
    print(
        f"[DONE] Pages: {counts['pages_fetched']}/{counts['total_pages_listed']} | "
        f"Images downloaded: {counts['images_downloaded']} | "
        f"Failed images: {counts['images_failed']}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
