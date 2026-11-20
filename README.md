[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/turibaru/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/turibaru/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — GitHub-compatible forge (single file)

Entri bounty make.fun **github-core-clone-01** ($500): sebuah forge standalone
yang kompatibel dengan GitHub, ditulis dalam **satu file `main.ts`** (Node 22,
stdlib saja — `node:http`, `node:crypto`, `node:zlib` — tanpa dependensi,
tanpa binary git, tanpa layanan luar).

## Menjalankan

```bash
node --experimental-strip-types main.ts
```

- Bind port ephemeral sendiri, lalu `POST {"port": N}` ke
  `$MAKEFUN_ENV_URL/register` (retry dengan backoff) dan long-poll
  `GET $MAKEFUN_ENV_URL/done` sampai suite selesai, lalu exit 0.
- Tanpa `MAKEFUN_ENV_URL`, server jalan standalone dan mencetak port-nya
  (mode latihan lokal).
- `GET /healthz` menjawab `{"ok": true}`.

## Yang dilayani (satu proses, store in-memory)

- **Smart HTTP git**: `info/refs` (v0 + v2), `git-upload-pack` (fetch v2/v0,
  shallow/deepen/unshallow, ls-refs), `git-receive-pack` (push, fast-forward
  check, `report-status`, `side-band-64k`). Pack ditulis/dibaca sendiri
  (objek polos + OFS/REF delta, SHA-1).
- **REST v3** (`/api/v3/`): repos (CRUD + paginasi `Link`), contents
  (buat/update/hapus file, commit message persis), branches, commits,
  git refs, labels, issues (CRUD, filter/sort/paginasi), komentar, pull
  request (buat, files/diff, squash merge, deteksi konflik → 405).
  Issue dan PR berbagi penomoran per repo. Auth Bearer
  (`MAKEFUN_SHOP_TOKEN`; bila env kosong, Bearer apa pun diterima).
- **GraphQL** (`/api/graphql`): parser + executor sendiri — query/mutasi
  bentuk `gh` dan `github-mcp-server` (viewer, repository, issues,
  pullRequests, node, `__type`, createIssue/closeIssue/createPullRequest/
  mergePullRequest/addComment, cursor pagination, batch array).
- **MCP** (`/mcp`, JSON-RPC 2.0 Streamable HTTP): `server/discover`
  (2026-07-28 + 2025-11-25) dan `initialize` legacy; 7 tool —
  `create_repo`, `get_repo`, `list_repos`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — bekerja pada store yang
  sama dengan REST.

## Determinisme

Store in-memory; semua timestamp konstanta (`2025-01-01T00:00:00Z`,
commit epoch 1700000000) dan semua counter deterministik, jadi dua run pada
instance yang sama meninggalkan state yang sama.

## Uji lokal

```bash
# dari folder kit:
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:<PORT> --token test-token-123 --perf --json
```

Hasil terakhir (20 Nov 2026, instance fresh): **120/120 check fitur,
15/15 MCP, perf 146/200 → skor total 946/1000**
(feature 600, agent 200, perf 146). Lihat `STATUS.md` untuk detail.

---

<sub>Entered on [make.fun](https://make.fun/?ref=r34fvf50&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
