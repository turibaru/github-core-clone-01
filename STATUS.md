# STATUS — entri bounty github-core-clone-01

Terakhir diperbarui: 20 Nov 2026 ~13:20 WIB.

## Ringkasan

Forge GitHub-compatible satu file (`main.ts`, ~106 KB, Node 22, stdlib saja)
**siap-submit dari sisi kode**: lolos **120/120 check fitur** dan **15/15 MCP**
pada local runner kit, dengan skor total **946/1000** (feature 600 + agent 200
+ perf 146) pada instance fresh.

## Yang sudah dibangun

- `main.ts` — satu proses, satu file: bind port ephemeral → register ke
  `$MAKEFUN_ENV_URL/register` → poll `/done` → exit 0; standalone bila env
  unset; `GET /healthz` → `{"ok": true}`.
- Smart HTTP git: info/refs v0+v2, upload-pack (fetch v2/v0, shallow,
  deepen, unshallow, ls-refs), receive-pack (push + fast-forward check +
  report-status + side-band-64k); pack write/read sendiri (plain + OFS/REF
  delta, SHA-1).
- REST v3: repos CRUD + paginasi, contents (PUT 201/200/409, DELETE),
  branches, commits (message persis), git refs, labels, issues CRUD,
  komentar, PR (files/diff, squash merge, konflik → 405); issue+PR berbagi
  penomoran per repo.
- GraphQL: parser + executor sendiri untuk bentuk `gh` dan
  `github-mcp-server` (viewer, repository, issues, pullRequests, node,
  `__type`, 5 mutasi, cursor pagination, batch array, global id opaque).
- MCP: `server/discover` (2026-07-28 + 2025-11-25) dan `initialize` legacy;
  7 tool (`create_repo`, `get_repo`, `list_repos`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) di store yang
  sama dengan REST.
- Store in-memory, timestamp konstanta, counter deterministik.
- `LICENSE` (MIT, dari starter kit) + `README.md`.

## Hasil uji (bukti)

Local runner kit (`sdk/run.ts --url http://127.0.0.1:PORT --token test-token-123`):

| Run | Kondisi | Hasil |
| --- | --- | --- |
| run1 | instance fresh | 118/120 (gagal: `git.fetch-shallow-depth1`, `git.fetch-shallow-deepen`) |
| run2 | setelah perbaikan closure depth-1 | 119/120 (gagal: `git.fetch-shallow-deepen`) |
| run3 | setelah perbaikan have-ancestry | 119/120 (gagal: `git.fetch-shallow-deepen`) |
| run4 | setelah perbaikan haveObjects (tanpa parent traversal) | **120/120**, feature 600, agent 200, perf 0 (tanpa `--perf`), skor 800 |
| run-perf-1 | instance yang sama dipakai ulang (state kotor) | 36/120 — **artefak**, bukan bug forge: runner memakai ulang instance yang sudah berisi repo dari run sebelumnya |
| run-perf-2 | instance fresh, `--perf` | **120/120, MCP 15/15, perf 146/200 → skor total 946/1000** |

**Validasi akhir via `grade-local` (20 Nov 2026 ~13:22 WIB):**
`node cli/makefun.mjs grade-local --kit . --bot <entry> --driver process
--worktree --instances 1 --json` → status `finished`, **skor 939**
(feature 600, agent 200, perf 139, perf_p50_us 469062, working 1),
spend $0, snapshot `9b23155025d4d4b37e6db3b33b385d5123391cb45189d1f8ff0ea3ec60d94d50`,
state_sha256 `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`.
Ini trial resmi kit (env + scorer tersegel), bukan hanya runner lokal.

Detail perf (run-perf-2, p50): push 36 poin, clone 24, read 30, write 33
(p50 total ~589 ms; workload: 200 push, 50 clone dangkal bersamaan,
2.000 baca issue, 200 tulis issue). Perf bervariasi antar run
(run perf pertama: 123/200).

Dua bug shallow fetch yang diperbaiki selama pengujian:
1. Closure fetch depth-terbatas ikut menarik commit parent — diperbaiki
   agar hanya commit yang termasuk + tree/blob-nya yang dikirim.
2. `haveObjects` dihitung via reachability penuh sehingga menembus shallow
   boundary dan menghapus parent yang harus dikirim pada deepen — diperbaiki
   agar hanya commit yang dimiliki + tree closure-nya.

Smoke test manual (curl): `/healthz` 200, `/api/v3/` 200,
`/api/v3/meta`, `/api/v3/user` (login `adaiversen`), `POST /user/repos` 201,
`GET /repos/{owner}/{repo}` 200 — semua OK.

## Bagian yang belum / batasan yang diketahui

- **Determinisme dua run belum dibuktikan byte-per-byte** lewat export
  state resmi (forge tidak punya endpoint export state; determinisme
  dijamin lewat timestamp konstanta + counter deterministik, belum ada
  pembuktian dua run yang dibandingkan).
- **Store in-memory saja**: restart menghilangkan semua state (sesuai
  desain suite: satu run, satu instance).
- **Perf bukan maksimal**: 146/200 — masih ada ruang (terutama clone 24/50
  dan read 30/50), tapi di atas ambang kelayakan; optimasi lanjutan
  (mis. cache pack, fast-path issue read) belum dilakukan.
- Tidak ada UI (sesuai spesifikasi bounty).

## Yang MASIH KURANG untuk submit (belum dilakukan, sesuai instruksi)

1. **Repo GitHub publik** berisi `main.ts` di root (+ LICENSE + README ini)
   — BELUM dibuat (dilarang oleh instruksi tugas ini).
2. **GitHub PAT** untuk submit — sudah tersedia di tangan Adi
   (`~/.config/gh/hosts.yml`, akun turibaru, terverifikasi), tapi submit
   BELUM dilakukan.
3. **Bundle transcript** sesi kerja — belum dibuat.
4. Submit entri ke make.fun (akun @turibaru) — BELUM dilakukan.
5. Bounty tutup **21 Nov 2026 13:30 WIB** — submit harus sebelum itu.
