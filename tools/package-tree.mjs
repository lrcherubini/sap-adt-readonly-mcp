// adt_package_tree: what a package contains, to a depth, its objects paged.
//
// Built by buildTools (tools/index.mjs), which wraps it in the schema check and the journal.

import { finish, page } from '../lib/completeness.mjs';
import { record } from '../lib/audit.mjs';
import { virtualFoldersPost, parseVirtualFolders } from '../lib/virtual-folders.mjs';
import { asText } from './common.mjs';
import { invalidArguments } from '../lib/tool-error.mjs';

/** Objects listed per package in one answer of adt_package_tree. */
const TREE_OBJECTS_CEILING = 5000;

export function packageTreeTool(cfg, session, journal, _shared = {}) {
  const api = session.api;

  return {
    definition: {
      name: 'adt_package_tree',
      description:
        'Contents of a package: sub-packages and objects by type, with counts. `describe: true` ' +
        'adds each sub-package\'s description and `objectsBelow` (one more call); an object\'s ' +
        'description is adt_search\'s.',
      inputSchema: {
        type: 'object',
        properties: {
          packageName: { type: 'string' },
          depth: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description: 'Sub-package depth: default 1, at most 3 (5 with compact)',
          },
          max: { type: 'integer', minimum: 1, maximum: TREE_OBJECTS_CEILING, description: `Objects listed per package (default 500, at most ${TREE_OBJECTS_CEILING})` },
          offset: { type: 'integer', minimum: 0, description: 'First object of the listed package: `next.offset` of the previous answer' },
          compact: {
            type: 'boolean',
            description: 'Counts and hierarchy, no object list (a deep tree is MBs otherwise).',
          },
          describe: {
            type: 'boolean',
            description: 'One virtual-folders call per package. Default false.',
          },
        },
        required: ['packageName'],
      },
    },
    async handler({ packageName, depth, describe, compact, max, offset }) {
      const isCompact = compact === true;
      const depthCeiling = isCompact ? 5 : 3;
      if (depth !== undefined && depth !== null && Number(depth) > depthCeiling) {
        throw invalidArguments(`depth ${depth} is beyond ${depthCeiling}${isCompact ? '' : ' (5 with compact: true)'}: walk a sub-package from the answer instead.`);
      }
      const maxDepth = Number(depth) || 1;
      const seen = new Set();
      const wantsDescriptions = describe === true;
      const incomplete = [];

      // `description` is the sub-package text the PARENT fetched with describe: true; in
      // compact form the object list that carried it is dropped, so it rides on the node.
      const walk = async (pkg, level, description) => {
        if (seen.has(pkg) || level > maxDepth) return null;
        seen.add(pkg);
        const node = await api.nodeContents('DEVC/K', pkg);
        // `nodes` mixes two things: real objects, and the TYPE FOLDERS the ADT tree
        // draws ("Dictionary", "Business Services", ...). A folder comes back with an
        // OBJECT_TYPE like DEVC/Q1S and an EMPTY OBJECT_NAME. Counting them as
        // objects inflates the answer -- measured on ZDEMO_ERP_INT, which reported 11
        // objects when it holds 6. They are reported separately rather than dropped,
        // so the number still reconciles with what the tree shows.
        // ⚠️ DESCRIPTION IS NOT THE DESCRIPTION OF THE ROW IT SITS ON. Measured on
        // YDEMO_ROOT: the reply is 11 nodes -- the "Subpacotes" folder (empty name) plus ten
        // packages -- and the folder carries the FIRST package's text, each package carries
        // the NEXT one's, the last is empty. The library's parser is one object per XML
        // element (nodeContents.js), so nothing on this side can shift a child across
        // siblings: the server sends it that way, and the resource is POST-only (a raw GET
        // answers 405), so the bytes cannot be re-read through the GET seam. Realigning by
        // one would be a guess from one package with one folder; the text is carried as
        // what it is, and the search -- which answers correctly -- is offered instead.
        const all = (node.nodes ?? []).map((n) => ({
          name: n.OBJECT_NAME,
          type: n.OBJECT_TYPE,
          // The row's DESCRIPTION is the next row's text (measured): it is not handed on at all,
          // because a text known to belong to another object is worse than none.
        }));
        const objects = all.filter((o) => (o.name ?? '').trim());
        const subs = objects.filter((x) => x.type === 'DEVC/K');
        if (wantsDescriptions && subs.length) {
          // One POST for the whole package (lib/virtual-folders.mjs): every sub-package's
          // description, aligned, and the objects below it. The search per sub-package stays as
          // the fallback, so a failed POST costs calls, never the answer.
          let vf = null;
          if (session.raw) {
            let out;
            try {
              out = await virtualFoldersPost(session.raw, pkg);
              vf = parseVirtualFolders(out.body);
            } catch (e) {
              journal?.gap?.({
                code: 'PACKAGE_FOLDERS_NOT_READ',
                subject: pkg,
                detail: `HTTP ${e?.status ?? '?'}: ${e?.message}`,
                impact: 'the descriptions were read through the search instead (one call per sub-package); objectsBelow is not given',
                fallback: 'the project explorer of Eclipse ADT',
              });
            } finally {
              record(cfg, 'adt_package_tree', `${pkg}#folders`, out?.bytes ?? 0);
            }
            if (vf?.drift.length) {
              journal?.gap?.({
                code: 'SHAPE_DRIFT',
                subject: pkg,
                detail: vf.drift.map((d) => `<${d.node}> x${d.count}`).join('; '),
                impact: 'the folders read stand; the measured shape of the virtual folders has aged',
                fallback: 're-measure (docs/adt-api-reference.md, "Virtual folders")',
              });
            }
          }
          let undescribed = 0;
          for (const o of subs) {
            const f = vf?.subPackages.find((x) => String(x.name).toUpperCase() === String(o.name).toUpperCase());
            if (f) {
              o.description = f.description;
              o.objectsBelow = f.objectsBelow;
              o.descriptionSource = 'folders';
            } else {
              const hits = await api.searchObject(o.name, 'DEVC/K', 5);
              const own = hits.find((h) => String(h['adtcore:name']).toUpperCase() === String(o.name).toUpperCase());
              o.description = own?.['adtcore:description'] ?? null;
              o.descriptionSource = own ? 'search' : 'notFound';
              if (!own) undescribed += 1;
            }
          }
          if (undescribed) incomplete.push({ list: `${pkg}.subPackages.description`, code: 'NOT_READ', count: undescribed, reason: 'neither the folders nor the search answered the sub-package' });
        }
        const folders = all.length - objects.length;
        const byType = objects.reduce((acc, o) => {
          acc[o.type] = (acc[o.type] ?? 0) + 1;
          return acc;
        }, {});
        const subPackages = [];
        const notWalked = [];
        for (const sub of objects.filter((o) => o.type === 'DEVC/K')) {
          if (level >= maxDepth) {
            notWalked.push(sub.name);
            continue;
          }
          const child = await walk(sub.name, level + 1, sub.description);
          if (child) subPackages.push(child);
        }
        if (notWalked.length) incomplete.push({ list: `${pkg}.subPackages`, code: 'DEPTH_LIMIT', count: notWalked.length, packages: notWalked });
        // The objects of each package, paged: `offset` applies to the package asked, and the
        // `next` of any other names it, to be asked as packageName.
        const listed = isCompact ? null : page(objects, { max, offset: level === 1 ? offset : 0, defaultMax: 500, ceiling: TREE_OBJECTS_CEILING });
        const next = listed?.next ? { packageName: pkg, offset: listed.next.offset } : null;
        if (listed?.truncated) incomplete.push({ list: `${pkg}.objects`, code: 'CAP_REACHED', returned: listed.returned, total: listed.total, next });
        return {
          package: pkg,
          ...(isCompact && description !== undefined ? { description } : {}),
          total: objects.length,
          ...(folders ? { treeFolders: folders } : {}),
          byType,
          ...(listed ? { objects: listed.items, objectsPage: { returned: listed.returned, offset: listed.offset, limit: listed.limit, ...(next ? { next } : {}) } } : {}),
          ...(notWalked.length ? { subPackagesNotWalked: notWalked } : {}),
          subPackages,
        };
      };

      const tree = await walk(packageName.toUpperCase(), 1);
      record(cfg, 'adt_package_tree', `${packageName}${isCompact ? '#compact' : ''}`, tree?.total ?? 0);
      return asText(finish({
        ...tree,
        depth: maxDepth,
        depthCeiling,
        ...(isCompact ? { compact: true } : {}),
      }, incomplete));
    },
  };
}
