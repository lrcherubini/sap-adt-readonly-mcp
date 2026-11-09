#!/usr/bin/env node
// npm run propose:table -- T682I TVCPF
//
// The evidence for adding a table to `CUSTOMIZING_TABLES` (lib/data-preview.mjs), printed so a
// PERSON can decide. It writes nothing, changes nothing, and adds no table anywhere: the list
// stays a literal that grows by commit, which is the whole property docs/security.md defends.
//
// WHY A SCRIPT AND NOT A RULE. The proposal was to replace the closed list with a rule -- any
// delivery class C table, any Z*/Y*. It was measured and refused (docs/security.md).
// The rule does not even cover the list that exists (TFRM and TVCPA are class G, T681 is W), and
// class C says nothing about content: a class C customer table can hold personal data. What was true is that the delivery class IS readable -- so it became
// evidence for a review instead of a gate, and the review got cheap instead of the fence getting
// wide.
//
// Cost: one ADT call per table (a GET, through the same guarded seam as the server; nothing is
// locked, nothing is transported). Needs a TTY: the password is typed per run and never stored.
//
// Exit code: 0 only when every table asked about came back REVIEW. A failed read, a REFUSE or an
// UNKNOWN exits 1 -- so a caller can never read silence as approval.

import { writeFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { connect, disconnect } from '../lib/session.mjs';
import { buildTools } from '../tools/index.mjs';
import {
  parseTableMeta,
  verdictOf,
  mapEntryLine,
  expandIncludes,
  completeness,
  foldDdicElement,
  compareViews,
  readInChunks,
  NOT_IN_SOURCE,
} from '../lib/table-meta.mjs';
import { CUSTOMIZING_TABLES } from '../lib/data-preview.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { parseEnhancementElements, enhancementRouteFor, segmentFor } from '../lib/enhancement-elements.mjs';

const RULE = '='.repeat(88);

const argv = process.argv.slice(2);
const depthAt = argv.indexOf('--depth');
const maxDepth = depthAt >= 0 ? Number(argv[depthAt + 1]) : undefined;
if (depthAt >= 0 && (!Number.isInteger(maxDepth) || maxDepth < 1)) {
  console.error('--depth takes a positive integer.');
  process.exit(2);
}

// --out <file>: the whole report goes to a file and the terminal gets one line per table.
//
// A run over a dozen real tables does not fit in a terminal -- KOMG alone prints ~500 fields and
// KNA1 another 180 -- and a scrollback that drops the first half is worse than no transcript,
// because what is missing is invisible. With --out nothing is lost and the file can be diffed
// between runs, which is what makes it a CHECK rather than a look.
const outAt = argv.indexOf('--out');
const outPath = outAt >= 0 ? argv[outAt + 1] : null;
if (outAt >= 0 && (!outPath || outPath.startsWith('-'))) {
  console.error('--out takes a file path.');
  process.exit(2);
}

const names = argv
  .filter((a, i) => !a.startsWith('-') && !(depthAt >= 0 && i === depthAt + 1) && !(outAt >= 0 && i === outAt + 1))
  .map((a) => a.toUpperCase());

if (!names.length) {
  console.error('Usage: npm run propose:table -- <TABLE> [<TABLE> ...]   (up to 25 per run)\n');
  console.error('Prints the DDIC header, the delivery class and the field list of each table,');
  console.error('plus the line to paste into CUSTOMIZING_TABLES. It adds nothing by itself.\n');
  console.error('  --depth N      follow includes at most N levels deep');
  console.error('  --out <file>   write the whole report to <file>; the terminal gets one line per table');
  process.exit(2);
}
if (names.length > 25) {
  console.error(`adt_read_source takes at most 25 names per batch; ${names.length} were given.`);
  process.exit(2);
}

// The report goes through `say`; `progress` is the terminal line, and the two are never the same
// destination. Without --out `say` IS the terminal and `progress` says nothing, so a plain run
// looks exactly as it did before.
const transcript = outPath ? [] : null;
const say = (...parts) => {
  if (transcript) transcript.push(parts.join(' '));
  else console.log(...parts);
};
const progress = (line) => {
  if (transcript) console.log(line);
};

if (transcript) {
  // A transcript that does not say WHERE and WHEN it was read cannot be compared with another one,
  // and comparing them is the whole reason to keep it.
  transcript.push(`propose:table transcript`);
  transcript.push(`read at   ${new Date().toISOString()}`);
  transcript.push(`asked for ${names.join(' ')}`);
}

const already = names.filter((n) => CUSTOMIZING_TABLES.has(n));
for (const n of already) {
  say(`${n} is already in CUSTOMIZING_TABLES: ${CUSTOMIZING_TABLES.get(n).why}`);
  // ALSO on the terminal under --out. Without this the name asked for simply never appears in the
  // view the person is watching: 21 names in, 20 summary lines out, and the one that vanished is
  // the one that needed no work. A name that disappears silently is indistinguishable from a name
  // that was dropped by a bug -- which is the failure this whole run was checking for.
  progress(`  ${n.padEnd(24)} already in CUSTOMIZING_TABLES -- not read`);
}
const toRead = names.filter((n) => !CUSTOMIZING_TABLES.has(n));
if (!toRead.length) {
  say('\nNothing to propose.');
  flushTranscript();
  process.exit(0);
}

const cfg = loadConfig();
say(`\nReading the DDIC header of ${toRead.length} table(s) from ${cfg.host}:${cfg.port} client ${cfg.client}.`);
say('One GET each. Nothing is locked, nothing is transported, nothing is written.\n');
if (transcript) {
  transcript.splice(2, 0, `system    ${cfg.host}:${cfg.port} client ${cfg.client}`);
  // BOTH counts, because they differ whenever a name is already in the list and reporting only one
  // of them invites "you said 21 and it says 20".
  console.log(
    `Transcript -> ${outPath}   (${names.length} asked, ${toRead.length} to read; one terminal line each)`
  );
}

const session = await connect(cfg);
let worst = 0;
try {
  const tools = buildTools(cfg, session);
  const readSource = tools.find((t) => t.definition.name === 'adt_read_source');
  if (!readSource) throw new Error('adt_read_source is not among the built tools.');

  const readBatch = async (names, objectType) => {
    const answer = await readSource.handler(objectType ? { objectNames: names, objectType } : { objectNames: names });
    return JSON.parse(answer.content[0].text);
  };
  /**
   * The reader `expandIncludes` injects, and the one that reads an append's source.
   *
   * `objectType` is NOT an optimisation here, it is the difference between reading and not
   * reading. A DDIC name is only unique WITHIN a type, and a structure sharing its name with a
   * domain is ordinary: the resolver refuses to rank `PRODH` (AUTH, DOMA/DD and TABL/DS all
   * answer to it) and `INCO_L` (DOMA/DD and TABL/DS), and asks for the type. Without it those
   * includes came back as "no source returned", which reads as a failed read of something
   * unknown -- and `PRODH` is a whole SUBTREE (`include prodhs; include produhf;`), so KOMG's
   * 497 fields were short by all of it. Measured; both read fine WITH the type.
   *
   * Passing it is not a guess: an include is a structure, and so is an append (the enhancement
   * resource types every one of them `TABL/DS`).
   */
  const readStructures = async (names) =>
    new Map((await readBatch(names, 'TABL/DS')).items.map((i) => [i.name, { source: i.source || null, error: i.error ?? null }]));

  // The batch limit is 25 NAMES PER REQUEST, not 25 names per question -- and slicing to the first
  // 25 is how a cap turns into a silent wrong answer. KOMG names 28 appends; the three that fell
  // off the end included `zdemo_kompaz`, the exact case this whole route was added to reach, and it
  // printed as "source not read" instead. Chunk, never truncate.
  const readStructuresAll = (names) => readInChunks(names, readStructures);

  // The second view, through the SAME guarded client the server uses: `ddicElement` is on the
  // allowlist, so this adds no route and no surface. A failure here is reported, never fatal --
  // the source view alone is still worth printing.
  const readDdic = async (name) => {
    try {
      return foldDdicElement(await session.api.ddicElement(name));
    } catch (e) {
      return { ok: false, why: `${e.name ?? 'Error'}: ${e.message}`, package: null, blocks: [], fields: [] };
    }
  };

  // THE THIRD VIEW: which append reaches each node, BY NAME. One GET per node, through the named
  // route added 2026-09-22 (lib/adt-get.mjs). This is the only route to the question for a
  // structure, whose ddicElement tree is always empty -- KOMG -> KOMPAZ -> ZDEMO_KOMPAZ (ZZDEMOFLD) is
  // invisible to every other read.
  const transport = session.raw ? transportFor(session.raw) : null;
  const readEnhancements = async (name, kind) => {
    if (!transport) return { ok: false, why: 'no raw session', appends: [] };
    const route = enhancementRouteFor(kind);
    const segment = segmentFor(name);
    if (!route) return { ok: false, why: `no enhancement route for kind '${kind}'`, appends: [] };
    if (!segment) return { ok: false, why: `'${name}' is not a name these routes can address`, appends: [] };
    try {
      const out = await namedGet(transport, route, { name: segment });
      const parsed = parseEnhancementElements(out.body);
      return { ok: true, appends: parsed.appends, drift: parsed.drift };
    } catch (e) {
      // 404 here is the ordinary case: the object publishes no enhancements link. That is
      // "nothing to enumerate" and NOT "no append exists" -- both negative controls that answered
      // this way were #NOT_EXTENSIBLE, so the two conditions are confounded in the measurement.
      return { ok: false, status: e.status ?? null, why: `${e.status ?? ''} ${e.message}`.trim(), appends: [] };
    }
  };

  const payload = await readBatch(toRead, 'TABL/DT');
  worst = await report(payload, readStructures, readDdic, readEnhancements, readStructuresAll);
} catch (e) {
  // A crash mid-run must not swallow what was already read: the transcript IS the evidence, and a
  // partial one with the error in it is worth more than none.
  say(`\nRUN FAILED: ${e?.stack ?? e}`);
  flushTranscript();
  await disconnect(session);
  process.exit(1);
} finally {
  await disconnect(session);
}

say(`\n${RULE}`);
say('This script added nothing. The list grows by commit, reviewed in a diff --');
say('docs/security.md, "the delivery-class rule was measured and refused, 2026-09-22".');
flushTranscript();
process.exit(worst);

/**
 * Write the transcript, once, at the end. It is written even when the run failed -- a partial
 * transcript with the error in it is evidence; a missing one is not.
 */
function flushTranscript() {
  if (!transcript) return;
  try {
    writeFileSync(outPath, `${transcript.join('\n')}\n`, 'utf8');
    console.log(`\nTranscript written: ${outPath}  (${transcript.length} lines)`);
  } catch (e) {
    console.error(`Could not write ${outPath}: ${e.message}`);
    console.error('The report is below instead, so nothing is lost:\n');
    console.log(transcript.join('\n'));
  }
}

/** The reader answers `{source, error}` so the REASON survives; every consumer wants the source. */
function srcOf(map, name) {
  const got = map.get(String(name).toUpperCase()) ?? map.get(name) ?? null;
  return typeof got === 'string' ? got : (got?.source ?? null);
}

async function report(payload, readStructures, readDdic, readEnhancements, readStructuresAll) {
  let worstSoFar = 0;
  for (const item of payload.items ?? []) {
    say(`\n${RULE}\n${item.name}${item.package ? `  --  package ${item.package}` : ''}`);
    if (!item.source) {
      // A failed read is not an absent table, and it is certainly not a safe one.
      say(`  NOT READ: ${item.error ?? 'the answer carried no source'}`);
      say('  Nothing can be said about this table. It is not refused and it is not cleared.');
      worstSoFar = 1;
      continue;
    }

    const meta = parseTableMeta(item.source);
    const pad = (k) => `  ${k.padEnd(17)}`;
    // "not applicable" and "not in the source" are different answers, and a structure legitimately
    // has neither a table category nor a delivery class.
    const absent = meta.kind === 'structure' ? '(not applicable -- this is a structure)' : '(not in the source)';
    say(pad('label') + (meta.label ?? '(none)'));
    say(pad('DDL') + (meta.kind ? `define ${meta.kind}` : '(no define found)'));
    say(pad('table category') + (meta.tableCategory ?? absent));
    say(
      pad('delivery class') +
        (meta.deliveryClass ? `${meta.deliveryClass}  --  ${meta.deliveryClassText ?? 'unknown class'}` : absent)
    );
    say(pad('data maintenance') + (meta.dataMaintenance ?? absent));

    // The field list is the point of this script. The delivery class does not tell a reviewer
    // whether a row is configuration or a person; the fields do, and no heuristic replaces
    // reading them -- a name proves nothing about what a table holds.
    //
    // Includes are followed to the end (they nest: KNA1 -> SI_KNA1 -> KNA1BRAZIL), because a
    // field list that stops at `include si_kna1` is missing ~150 fields of KNA1.
    const out = await expandIncludes(meta, readStructures, maxDepth ? { maxDepth } : {});
    const { fields, resolved, unresolved, nodes } = out;
    const own = fields.filter((f) => !f.from).length;
    say(
      `  fields (${fields.length}: ${own} own + ${fields.length - own} from ${resolved.length} include(s))` +
        ' -- READ THESE: they, not the class, say what a row is'
    );
    for (const f of fields) {
      say(`    ${f.isKey ? 'KEY' : '   '} ${f.name.padEnd(30)} ${(f.type ?? '').padEnd(30)} ${f.from ?? ''}`);
    }
    if (unresolved.length) {
      // An include that could not be read is reported, never skipped: a short list always biases
      // the reading towards "this table has no such field".
      // An include that does not exist is NOT a gap: an unimplemented customer include contributes
      // no field, so the list is complete without it. Saying "short by an unknown amount" for the
      // four CI_* of a KOMG makes the warning fire on nearly every large standard structure, and a
      // warning that is always on stops being read -- taking the real case with it.
      const gaps = unresolved.filter((u) => !u.missing);
      const missing = unresolved.filter((u) => u.missing);
      if (gaps.length) {
        say(`\n  ⚠ ${gaps.length} include(s) NOT resolved -- the list above is short by an unknown amount:`);
        for (const u of gaps) say(`    ${u.name}: ${u.why}`);
      }
      if (missing.length) {
        say(`\n  ${missing.length} include(s) do not exist in this system, and take no field with them:`);
        say(`    ${missing.map((u) => u.name).join(', ')}`);
      }
    }

    // Completeness per NODE, not per table. Nesting mixes freely, so the gap is often NOT at the
    // table: KOMG includes KOMPAZ, and it is KOMPAZ that carries the append ZDEMO_KOMPAZ (ZZDEMOFLD).
    const c = completeness(out);

    // THE THIRD VIEW, asked BEFORE anything is said about completeness. `ddicElement` sees append
    // fields on a table but never which append they came from, and it sees nothing at all on a
    // structure -- so this is the only route to the question for KOMPAZ, and the only route to the
    // NAME for WBRF. It runs first because the completeness sentence below is a DIFFERENT sentence
    // once a node has actually been enumerated: KOMG printed "CAN carry an append not shown here"
    // for 42 nodes and then listed 28 appends by name, which is the report arguing with itself.
    const asked = [];
    for (const node of nodes) {
      const kind = node.depth === 0 ? meta.kind : 'structure';
      asked.push({ node, kind, ...(await readEnhancements(node.name, kind)) });
    }
    const withAppends = asked.filter((a) => a.ok && a.appends.length);
    const refusedAsk = asked.filter((a) => !a.ok);
    const enumerated = new Set(asked.filter((a) => a.ok).map((a) => a.node.name));
    // An open node that WAS enumerated is no longer an unknown: its appends are named below.
    const stillDark = c.open.filter((n) => !enumerated.has(n));
    say(`\n  structures read: ${nodes.length} (nesting depth ${Math.max(...nodes.map((n) => n.depth))})`);

    // THE SECOND VIEW. Up to 2026-09-22 this script could only warn that an append MIGHT exist,
    // for every table, forever -- a warning that is true of almost every table is not information.
    // `ddicElement` on a TABLE answers the active field list with the append fields IN it, so the
    // difference between the two views IS the set of fields that came from outside any source.
    const folded = await readDdic(item.name);
    const cmp = compareViews(fields, folded);

    if (!cmp.available) {
      // Structures answer empty here BY OBJECT TYPE, so this is the expected path for them and the
      // generic warning is all that can honestly be said.
      say(`  second view unavailable: ${folded.why}`);
      if (c.closed.length) say(`    provably closed (#NOT_EXTENSIBLE): ${c.closed.join(', ')}`);
      if (enumerated.size) say(`    ${enumerated.size} node(s) enumerated BY NAME below -- no longer unknown`);
      if (stillDark.length) say(`    CAN carry an append, and was NOT enumerated: ${stillDark.join(', ')}`);
      if (c.unknown.length) say(`    category not read or not classified: ${c.unknown.join(', ')}`);
      // The blanket warning is only true where nothing was enumerated. Printing it directly above a
      // list of 28 named appends teaches the reader to ignore it, which costs the one case it is for.
      if (stillDark.length || !enumerated.size) say(`\n  ⚠ ${NOT_IN_SOURCE}`);
    } else if (!cmp.fromOutside.length && !cmp.appendMarkers) {
      say(`  ✓ NO APPEND: the active DDIC list has the same ${folded.fields.length} field(s) as the`);
      say('    source, and not one .append marker. Nothing reaches this table from outside.');
      if (!c.complete) {
        // "None today" and "none ever" are different claims and the difference is worth one line:
        // an extensible table is one transport away from a field this list does not have.
        say(`    (Still extensible, so this is true TODAY, not forever: ${c.open.concat(c.unknown).join(', ')})`);
      }
    } else {
      // An append block and an include block are DIFFERENT findings and were printed under one
      // heading until 2026-09-22, when ZDEMO_INVMAP_D showed six draft fields from a `.include`
      // announced as "an append structure, or a field from the Custom Fields app". Naming the
      // wrong mechanism sends the reader to SE11 > Append structures to look for something that
      // was never there.
      const byAppend = cmp.fromOutside.filter((f) => f.marker === '.append');
      const byInclude = cmp.fromOutside.filter((f) => f.marker !== '.append');
      const line = (f) => {
        const t = f.dataElement ?? `${f.dataType}${f.length ? `(${f.length}${f.decimals ? `,${f.decimals}` : ''})` : ''}`;
        return `    ${f.isKey ? 'KEY' : '   '} ${f.name.padEnd(30)} ${String(t).padEnd(30)} block ${f.block}`;
      };
      if (byAppend.length) {
        say(`  ⚠ ${byAppend.length} FIELD(S) FROM AN APPEND, in ${cmp.appendMarkers} block(s).`);
        say('    These are in the table and in no source anyone can read -- an append structure,');
        say('    or a field from the Custom Fields app. Read them like any other field:');
        for (const f of byAppend) say(line(f));
      }
      if (byInclude.length) {
        say(`  ⚠ ${byInclude.length} field(s) after an .include MARKER, origin not decided here.`);
        say('    Two different things land in this bucket and the DDIC list cannot tell them apart:');
        say('      - an include declared by an APPEND, not by this table (on WBRF and KNA1 the base');
        say('        source declares none of these -- WBRF_ADDON_GT is only `include wb2b_cond_key`);');
        say('      - a field the append declares AFTER an include, which the "fields until the next');
        say('        marker" rule hands to the include instead (AKNA1_FMFG: DUNS and three more).');
        say('    The append list below is the authority on which append owns what:');
        for (const f of byInclude) say(line(f));
      }
    }
    if (cmp.available && cmp.missingFromDdic.length) {
      // The source claims a field the active table does not have. Never dropped silently.
      say(`\n  ⚠ in the source but NOT in the active table: ${cmp.missingFromDdic.join(', ')}`);
      say('    The source read and the DDIC disagree -- do not trust either list until this is explained.');
    }

    if (withAppends.length) {
      const all = [...new Set(withAppends.flatMap((a) => a.appends.map((x) => x.name)))];
      say(`\n  APPENDS, BY NAME (enhancement/elements): ${all.length} across ${withAppends.length} node(s).`);
      // Their fields are one source read each -- the reply names appends and lists no field.
      // A namespaced name is NOT excluded here: `/VSO/R_KNA1_A` reads fine by name (measured
      // 2026-09-22). Only the enhancement ROUTE has an alphabet that stops at the slash, and
      // pre-filtering on that made the report claim a source could not be read when it could.
      const sources = all.length ? await readStructuresAll(all) : new Map();

      // IS THIS APPEND ACTUALLY IN THE TABLE? Naming it does not put it there. On KNA1 the
      // resource names 11 appends while the active DDIC list carries 7 `.append` blocks, and the
      // four with no block belong to an industry solution (OI*_KNA1), and none of their fields is
      // in the table. Printing OIDRC without saying so invites code written against a field that is
      // not there. WHY they are absent is NOT read anywhere here -- a switch is the likely cause and
      // was never verified, so the report says absent and stops.
      //
      // The test is MEMBERSHIP, not position: does any field this append declares appear in the
      // active list? That is sound whatever the marker order does, which is why it is the check
      // used and the block pairing is not.
      const activeNames = new Set(folded.ok ? folded.fields.map((f) => f.name) : []);
      // Whether the membership test could run at all. On a STRUCTURE there is no active list, so no
      // append can ever be marked -- and printing the legend for a marker that cannot appear is one
      // more line teaching the reader that this block is boilerplate. KOMG printed it for 28
      // appends, none of which could have carried the mark.
      let marked = false;
      // An append whose body is only an include declares no field of its own, so its include is
      // read one level down to have something to test.
      const viaInclude = [
        ...new Set(
          all
            .map((n) => srcOf(sources, n))
            .filter(Boolean)
            .map((src) => parseTableMeta(src))
            .filter((m) => !m.fields.length && m.includes.length)
            .flatMap((m) => m.includes)
        ),
      ];
      const indirect = viaInclude.length ? await readStructuresAll(viaInclude) : new Map();
      const testableFields = (sub) => {
        if (sub.fields.length) return sub.fields.map((f) => f.name);
        return sub.includes.flatMap((n) => {
          const src = srcOf(indirect, n);
          return src ? parseTableMeta(src).fields.map((f) => f.name) : [];
        });
      };
      for (const a of withAppends) {
        say(`    on ${a.node.name}${a.node.depth ? ` (include, depth ${a.node.depth})` : ''}:`);
        for (const ap of a.appends) {
          const src = srcOf(sources, ap.name);
          const sub = src ? parseTableMeta(src) : null;
          // The membership verdict goes on the NAME line, where it cannot be missed.
          let mark = '';
          if (sub && activeNames.size) {
            marked = true;
            const testable = testableFields(sub);
            if (testable.length) {
              const present = testable.filter((n) => activeNames.has(n)).length;
              if (present === 0) mark = '   ← NOT IN THE ACTIVE TABLE';
              else if (present < testable.length) mark = `   ← only ${present}/${testable.length} of its fields are active`;
            }
          }
          say(`      ${ap.name.padEnd(34)} ${ap.shortText ?? ''}${mark}`);
          if (!sub) {
            say('        source not read -- the fields of this append are unknown, not absent');
          } else if (!sub.fields.length && sub.includes.length) {
            // An append whose whole body is an include is common (`WBRF_ADDON_GT`,
            // `/VSO/R_KNA1_A`, `J_3GKNA1A`). Printing "no field" for it says the opposite of the
            // truth: it brings a whole structure.
            say(`        brings no field directly -- its body is: include ${sub.includes.join(', ')}`);
          } else {
            say(`        ${sub.fields.map((f) => f.name).join(', ') || 'no field and no include: the source parsed to an empty body'}`);
            if (sub.includes.length) {
              // AKNA1_FMFG declares alc, pmt_office, `include si_fmfg_vp2`, then four more fields.
              // The flat DDIC list attributes everything after the include marker to the INCLUDE,
              // so the block split disagrees with this line. This line is the authority.
              say(`        + include ${sub.includes.join(', ')} -- so the block split above under-reports this append`);
            }
          }
        }
      }
      say('\n    An append named Z* whose FIELDS have no Z is normal -- ZDEMO_STR_EXIT carries');
      say('    DT_COMP and ST_COMP. No name heuristic finds those; only this list does.');
      if (marked) {
        say('    NOT IN THE ACTIVE TABLE means the append exists as an object but none of its');
        say('    fields are in the DDIC list. This says the fields are ABSENT, not why -- nothing');
        say('    read here knows about switches, activation state or targets. Do not write code');
        say('    against those fields, and check SE11/SFW_BROWSER before concluding a cause.');
      }
    } else if (asked.some((a) => a.ok)) {
      // This used to warn that the empty answer might be a silence rather than a finding, because
      // in the first measurement the only objects that listed nothing were also #NOT_EXTENSIBLE.
      // A run of 8 tables on 2026-09-22 separated them: the resource answered for EVERY node asked
      // -- extensible tables with no append, and KNA1BRAZIL, which is #NOT_EXTENSIBLE and publishes
      // no enhancements link at all. The empty list is an observation, not a silence.
      say(`\n  APPENDS, BY NAME: none, on all ${asked.filter((a) => a.ok).length} node(s) read.`);
      say('    The resource answered for each of them, so this is an empty list and not a silence.');
      say('    It says no append reaches this table TODAY -- not that none ever can.');
    }
    if (refusedAsk.length) {
      say(`\n  append list not read for ${refusedAsk.length} node(s):`);
      for (const a of refusedAsk) say(`    ${a.node.name}: ${a.why}`);
    }

    const v = verdictOf(meta);
    say(`\n  VERDICT: ${v.verdict}`);
    say(`    ${v.why}`);
    if (v.verdict === 'REVIEW') {
      say('\n  Paste into CUSTOMIZING_TABLES (lib/data-preview.mjs) and fill in `why`:');
      say(mapEntryLine(item.name));
      // The list is pinned by a test on purpose: it cannot grow without a deliberate edit that
      // shows up in the diff. Pasting only the Map line leaves `npm test` red, which reads as a
      // broken tool rather than as the guard it is.
      say(`  Then add '${item.name}' to the pinned list in tests/data-preview.test.mjs`);
      say("  ('the allow-list is closed and every entry says why'). Run npm test after both.");
    } else {
      worstSoFar = 1;
    }

    // One line per table on the terminal, so a long run is watchable and a surprise is visible
    // while it happens rather than at the end of a file.
    const appendCount = withAppends.reduce((n, a) => n + a.appends.length, 0);
    const outside = cmp.available ? cmp.fromOutside.filter((f) => f.marker === '.append').length : null;
    progress(
      `  ${item.name.padEnd(24)} ${v.verdict.padEnd(7)} ` +
        `${String(fields.length).padStart(4)} fields  ${String(nodes.length).padStart(3)} nodes  ` +
        `${String(appendCount).padStart(3)} appends  ` +
        `${outside === null ? 'active list n/a' : `${outside} field(s) from append`}` +
        `${c.gaps.length ? `  ⚠ ${c.gaps.length} include(s) unresolved` : ''}` +
        `${refusedAsk.length ? `  ⚠ ${refusedAsk.length} node(s) not enumerated` : ''}`
    );
  }
  return worstSoFar;
}
