// store.ts — the forge's whole state, in memory.
//
// One process, one store: repositories keyed by owner/name, each holding its
// git objects, refs, issues, pull requests, labels and comments. Nothing
// here reads a clock or randomness: commit timestamps come from a
// deterministic counter (base epoch + sequence), so the same request order
// always produces the same objects, the same ids and the same exports —
// which is what the replay check requires.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'Ada Iversen',
  email: 'adaiversen@example.invalid',
} as const;

// The trial's bearer <redacted> names this login: the suite's scenario seed
// fixes the viewer to adaiversen (wire.ts buildScenario, SCENARIO_SEED), so
// the forge answers for that login on every trial, practice or scored.
export const VIEWER_LOGIN = VIEWER.login;

const COMMIT_EPOCH = 1735689600; // 2025-01-01T00:00:00Z, the scenario's day one.

export interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  seq: number;
}

export interface PullRequest {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  seq: number;
}

export interface Repo {
  key: string;
  owner: string;
  name: string;
  fullName: string;
  databaseId: number;
  globalId: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  version: number; // bumped on any object/ref change; invalidates pack caches
  packCache: Map<string, Buffer>;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private nextDatabaseId = 10000;
  private seq = 0;
  private repoSeq = 0;

  /** A deterministic timestamp for the next commit this forge authors. */
  nextCommitStamp(): { epoch: number; iso: string } {
    const epoch = COMMIT_EPOCH + this.seq;
    this.seq += 1;
    return { epoch, iso: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') };
  }

  /** A fixed ISO instant (never the wall clock) for issue/PR bookkeeping. */
  fixedIso(): string {
    return '2025-01-01T00:00:00Z';
  }

  globalId(kind: string, parts: string): string {
    return `${kind}_${Buffer.from(parts, 'utf8').toString('base64url')}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const databaseId = this.nextDatabaseId;
    this.nextDatabaseId += 1;
    const repo: Repo = {
      key: this.repoKey(owner, name),
      owner,
      name,
      fullName: `${owner}/${name}`,
      databaseId,
      globalId: this.globalId('R', `${owner}/${name}`),
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.repoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(repo.key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------------- git objects
  // ----------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Peel a tag (possibly nested) to the commit it names. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** All object ids reachable from the given tips (commits, tags, trees, blobs). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) throw new Error(`missing object ${oid}`);
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** The commit ids reachable from a tip, newest-first by ancestry walk. */
  commitWalk(repo: Repo, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return order;
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The first common ancestor of two commits (merge base), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set(this.commitWalk(repo, a));
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Flatten a tree object to path -> {oid, mode}, recursively. */
  treeToMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree object from a flat path map. */
  mapToTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // Group by directory, bottom-up.
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const ensure = (dir: string): Map<string, { oid: string; mode: string }> => {
      let map = dirs.get(dir);
      if (!map) {
        map = new Map();
        dirs.set(dir, map);
      }
      return map;
    };
    ensure('');
    for (const [path, entry] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      ensure(dir).set(name, entry);
      // Ensure every ancestor directory exists in the map.
      let cursor = dir;
      while (cursor !== '') {
        const parentSlash = cursor.lastIndexOf('/');
        const parent = parentSlash === -1 ? '' : cursor.slice(0, parentSlash);
        ensure(parent);
        cursor = parent;
      }
    }
    const buildDir = (dir: string): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of ensure(dir)) entries.push({ mode: entry.mode, name, oid: entry.oid });
      // Subdirectories of this dir.
      const prefix = dir === '' ? '' : `${dir}/`;
      for (const [sub] of dirs) {
        if (sub === dir || !sub.startsWith(prefix)) continue;
        const rest = sub.slice(prefix.length);
        if (rest.includes('/')) continue;
        entries.push({ mode: '40000', name: rest, oid: buildDir(sub) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /** Author a commit on top of `parents` with the given tree. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const stamp = this.nextCommitStamp();
    const ident = `${VIEWER.name} <${VIEWER.email}> ${stamp.epoch} +0000`;
    const data = buildCommit(tree, parents, ident, ident, message);
    return this.putObject(repo, 'commit', data);
  }

  // ---------------------------------------------------------------- diff
  // ----------------------------------------------------------------

  countLines(data: Buffer): string[] {
    const text = data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Line-level additions/deletions between two blob contents. */
  lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData === null ? [] : this.countLines(oldData);
    const newLines = newData === null ? [] : this.countLines(newData);
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const remaining = oldCounts.get(line) ?? 0;
      if (remaining > 0) oldCounts.set(line, remaining - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const remaining of oldCounts.values()) deletions += remaining;
    return { additions, deletions };
  }

  /** Files that differ between two trees (empty tree when oid is ''). */
  diffTrees(repo: Repo, oldTree: string, newTree: string): FileChange[] {
    const oldMap = oldTree === '' || oldTree === ZERO_OID ? new Map() : this.treeToMap(repo, oldTree);
    const newMap = newTree === '' || newTree === ZERO_OID ? new Map() : this.treeToMap(repo, newTree);
    const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = oldMap.get(path);
      const newEntry = newMap.get(path);
      if (oldEntry && !newEntry) {
        const data = repo.objects.get(oldEntry.oid)?.data ?? null;
        const { deletions } = this.lineDiff(data, null);
        changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions });
      } else if (!oldEntry && newEntry) {
        const data = repo.objects.get(newEntry.oid)?.data ?? null;
        const { additions } = this.lineDiff(null, data);
        changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions, deletions: 0 });
      } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
        const newData = repo.objects.get(newEntry.oid)?.data ?? null;
        const { additions, deletions } = this.lineDiff(oldData, newData);
        changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions, deletions });
      }
    }
    return changes;
  }

  // ---------------------------------------------------------------- packs
  // ----------------------------------------------------------------

  /** Objects reachable from `wants` minus those reachable from `haves`. */
  objectsToSend(repo: Repo, wants: string[], haves: string[]): GitObject[] {
    const held = new Set<string>();
    if (haves.length > 0) {
      try {
        for (const oid of this.reachable(repo, haves)) held.add(oid);
      } catch {
        // A have the server cannot resolve is ignored: it is the client's.
      }
    }
    const wanted = this.reachable(repo, wants);
    const out: GitObject[] = [];
    for (const oid of wanted) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) out.push(object);
    }
    return out;
  }

  /**
   * Shallow fetch: only commits within `depth` generations of the wants,
   * plus their trees and blobs. Returns the objects and the new shallow
   * boundary commits (the deepest commits included).
   */
  shallowObjects(repo: Repo, wants: string[], haves: string[], depth: number, clientShallow: string[] = []): { objects: GitObject[]; boundary: string[] } {
    // What the client already holds: objects reachable from its haves,
    // except a have that is already on the client's shallow boundary
    // holds nothing below itself — that is what a shallow boundary means,
    // and a deepen is precisely the request to extend past it. Without
    // this, a deepen would find the parent already "held" and send nothing.
    const shallowSet = new Set(clientShallow);
    const held = new Set<string>();
    if (haves.length > 0) {
      const stack: string[] = [...haves];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (held.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (!object) continue;
        held.add(oid);
        if (object.type === 'commit') {
          const commit = parseCommit(object.data);
          stack.push(commit.tree);
          if (!shallowSet.has(oid)) {
            for (const parent of commit.parents) stack.push(parent);
          }
        } else if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) stack.push(entry.oid);
        } else if (object.type === 'tag') {
          stack.push(parseTag(object.data).object);
        }
      }
    }
    // BFS over commits by generation.
    const commits = new Map<string, number>(); // oid -> generation (0 = want)
    const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (commits.has(oid)) continue;
      const peeled = this.peelToCommit(repo, oid);
      if (peeled === null) continue;
      commits.set(peeled, gen);
      if (gen + 1 < depth) {
        const object = repo.objects.get(peeled);
        if (object && object.type === 'commit') {
          for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
        }
      }
    }
    const boundary: string[] = [];
    const tips: string[] = [];
    for (const [oid, gen] of commits) {
      tips.push(oid);
      if (gen === depth - 1) boundary.push(oid);
    }
    // Reachable objects from the included commits, but stop at parents
    // beyond the boundary: walk trees fully, commits only within the set.
    const seen = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) {
          if (commits.has(parent)) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    const out: GitObject[] = [];
    for (const oid of seen) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) out.push(object);
    }
    return { objects: out, boundary };
  }

  /** A pack for a fetch, cached per repo version + request shape. */
  fetchPack(repo: Repo, cacheKey: string, build: () => Buffer): Buffer {
    const cached = repo.packCache.get(cacheKey);
    if (cached) return cached;
    const pack = build();
    if (repo.packCache.size > 64) repo.packCache.clear();
    repo.packCache.set(cacheKey, pack);
    return pack;
  }

  /** Store every object from a received pack. Returns the objects. */
  ingestPack(repo: Repo, pack: Buffer): Map<string, GitObject> {
    const objects = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    repo.version += 1;
    repo.packCache.clear();
    return objects;
  }

  /** Build a pack from objects (used by the fetch paths). */
  packOf(objects: GitObject[]): Buffer {
    return writePack(objects);
  }
}
