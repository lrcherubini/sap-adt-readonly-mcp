// adt_annotation_chain -- which annotation reached this element, and from where.
//
// The question behind the tool is a real incident shape, not a curiosity: a field
// disappears from a Fiori app with no activation error, no /IWFND/ERROR_LOG entry and
// no clue in the source, because two `annotate entity` layers in the chain disagree and
// the last one wins silently. The workspace rule for that case says to diagnose it, not
// to conclude from a symptom -- and diagnosing it means asking the system which layer
// actually contributed each annotation.
//
// Nothing in the working tree answers that. Neither does `ddicElement()`: its
// `annotations` array comes back EMPTY on every node and every path shape
// (docs/adt-api-reference.md:107). The only resource that answers it is a collection
// with no client wrapper, reached here through the single named GET route in
// lib/adt-get.mjs.
//
// MEASURED 2026-09-09. The collection was called on the system for the first time, the
// reply is recorded verbatim in docs/adt-api-reference.md, and lib/annotation-chain.mjs
// parses that shape -- so this tool now answers rather than handing back evidence. The
// scaffolding for the other case stays: if the route is ever marked unmeasured again,
// the payload comes back raw with a warning and a SHAPE_UNOBSERVED gap, because a
// plausible answer with no evidence under it is the failure this server exists to refuse.
//
// What the measurement changed about the design, and would not have been guessed: the
// property set of a contribution DEPENDS ON ITS SOURCE KIND -- a metadata extension
// carries LAYER/LAYER_NAME, the view's own source carries neither and carries
// STATEMENT_TYPE instead. See the header of lib/annotation-chain.mjs.

import { record } from '../lib/audit.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { parseAnnotationChain, hiddenWithUiRole } from '../lib/annotation-chain.mjs';
import { finish } from '../lib/completeness.mjs';

const MAX_PAYLOAD = 20000;

/** The measured root of a chain and nothing under it: `<elementInfo><properties/></elementInfo>`. */
const BARE_ROOT = /^\s*(<\?xml[^>]*\?>)?\s*<abapsource:elementInfo\b[^>]*>\s*<abapsource:properties\s*\/>\s*<\/abapsource:elementInfo>\s*$/;

export function annotationChainTool(cfg, session, journal) {
  return {
    definition: {
      name: 'adt_annotation_chain',
      description:
        'The system\'s own annotation chain for one CDS element: the value that reaches the ' +
        'app, which layer set it, and keys written twice or silenced. One call.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: {
            type: 'string',
            description: 'CDS entity, e.g. ZC_DemoRosterMonitor',
          },
          element: {
            type: 'string',
            description: 'Element within the entity, e.g. Stcd2. Omit for the whole entity.',
          },
          variant: {
            type: 'string',
            description: 'Annotation variant, when the entity declares more than one.',
          },
          payloadOffset: {
            type: 'integer',
            minimum: 0,
            description: 'First character of an uninterpreted payload: `payloadPage.next.payloadOffset` of the previous answer',
          },
        },
        required: ['entity'],
      },
    },
    async handler(args = {}) {
      const params = {
        entity: args.entity,
        element: args.element,
        variant: args.variant,
      };
      let out;
      try {
        out = await namedGet(transportFor(session.raw), 'annotationChain', params);
      } catch (e) {
        // A RouteViolation never reached the network, so it costs no read and is not an
        // ADT gap -- it is a caller error. An HTTP failure is a gap: the question stands
        // unanswered, and "could not read" must never be filed as "nothing found".
        if (e?.name !== 'RouteViolation' && journal?.enabled) {
          journal.gap({
            code: 'ADT_ERROR',
            subject: `annotation chain of ${args.entity}`,
            detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? 'the annotation chain route'}`,
            impact:
              'the annotation chain of this element is unknown -- this is NOT evidence ' +
              'that no annotation conflicts',
            fallback:
              'read the annotate entity layers from source, or use the Eclipse ADT ' +
              'annotation view',
          });
        }
        throw e;
      }

      record(
        cfg,
        'adt_annotation_chain',
        [args.entity, args.element].filter(Boolean).join('/'),
        out.bytes
      );

      if (!out.shapeObserved && journal?.enabled) {
        journal.gap({
          code: 'SHAPE_UNOBSERVED',
          subject: 'ddic/ddlx/annotation/chain',
          detail: `${out.status} ${out.contentType ?? 'no content-type'}, ${out.bytes} bytes`,
          impact:
            'the payload is returned verbatim and not parsed: no conclusion about the ' +
            'chain can be drawn from this answer yet',
          fallback:
            'paste the raw payload into docs/adt-api-reference.md, then write the ' +
            'parser against the measured shape',
        });
      }

      // Unmeasured: hand back evidence, never a conclusion.
      if (!out.shapeObserved) {
        return json(finish({
          warning:
            'The shape of this reply has never been observed on this system. It is ' +
            'returned verbatim and NOT interpreted. Do not state which layer set an ' +
            'annotation on the basis of this answer until the payload has been ' +
            'recorded in docs/adt-api-reference.md and a parser written against it.',
          ...payloadOf(out.body, args.payloadOffset),
        }, [{ list: 'chain', code: 'PARSE_FAILED', reason: 'the reply shape is not measured: returned verbatim, not interpreted' }]));
      }

      const chain = parseAnnotationChain(out.body);

      // The measured root with nothing under it: the shape is known (its first line is the root
      // of every chain, lib/annotation-chain.mjs), and it holds no annotation. That is an
      // answer, not a parse failure -- but the system answers the same for an element the
      // entity does not have (measured 2026-11-12), so the answer says both and names the call
      // that tells them apart.
      if (chain.counts.contributions === 0 && BARE_ROOT.test(String(out.body ?? ''))) {
        return json(finish({
          entity: args.entity,
          element: args.element ?? null,
          counts: chain.counts,
          sources: [],
          annotations: [],
          conflicts: [],
          empty:
            'the system lists no annotation here. It answers the same for an element the entity ' +
            'does not have: adt_object_info on the entity lists its elements.',
          next: { tool: 'adt_object_info', arguments: { objectName: args.entity } },
        }, []));
      }

      // A 200 that parses to nothing is not "this element has no annotations": it is a
      // shape this parser did not recognise, and the two must never read the same. The
      // payload comes back so the next reader can see what actually arrived.
      if (chain.counts.contributions === 0) {
        if (journal?.enabled) {
          journal.gap({
            code: 'SHAPE_UNOBSERVED',
            subject: 'ddic/ddlx/annotation/chain',
            detail:
              `${out.status} ${out.contentType ?? 'no content-type'}, ` +
              `${out.bytes} bytes parsed to zero contributions`,
            impact:
              'the reply did not match the measured shape, so nothing is reported -- ' +
              'this is NOT evidence that the element carries no annotations',
            fallback:
              'compare the payload with tests/fixtures/annotation-chain-measured.xml',
          });
        }
        return json(finish({
          warning:
            `${out.bytes} bytes came back and none of it matched the measured shape. ` +
            'No conclusion is drawn. The element may genuinely carry no annotations, or ' +
            'the reply shape may have changed -- these two look identical here, so the ' +
            'raw payload is returned for comparison.',
          ...payloadOf(out.body, args.payloadOffset),
        }, [{ list: 'chain', code: 'PARSE_FAILED', reason: 'the reply parsed to zero contributions' }]));
      }

      // The cross-key contradiction: hidden AND given a display role, both active. It
      // produces NO conflict (the two keys are different), which is exactly why reading
      // `conflicts` alone was not enough -- measured twice on 2026-09-09.
      // The entity asked, not the payload's: each contribution names the entity it annotates, and
      // the first one is an upstream view whenever the asked one adds nothing of its own
      // (measured 2026-11-17: ZDEMO_C_CHANCTRL answered with ZDEMO_I_CHANNELUP). The same for the
      // element: a renamed one answers with its upstream name (SourceChannel came back as Channel).
      const hiddenRole = hiddenWithUiRole({ ...chain, entity: args.entity, element: args.element ?? chain.element });

      // Two sources writing one key is the diagnosis this tool exists for, so it is a
      // finding about the WORKSPACE, not a gap in the server.
      if (journal?.enabled) {
        for (const h of hiddenRole) {
          journal.finding({
            code: 'ANNOTATION_HIDDEN_WITH_ROLE',
            subject: `${args.entity}.${h.element ?? args.element ?? '*'}`,
            effect:
              `${h.hiddenBy?.name ?? 'an upstream layer'} sets @UI.hidden: true while ` +
              `${h.roleSources.map((s) => s.name).join(', ') || 'another layer'} gives it ` +
              `${h.roles.join(', ')} -- the field does not render, and no error is raised ` +
              'anywhere',
            context: {
              hiddenBy: h.hiddenBy?.name,
              hiddenByType: h.hiddenBy?.type,
              roles: h.roles.join(', '),
              roleSources: h.roleSources.map((s) => s.name).join(', '),
            },
          });
        }
        for (const c of chain.conflicts) {
          journal.finding({
            code: 'ANNOTATION_OVERRIDDEN',
            subject:
              `${args.entity}.${args.element ?? '*'} ` +
              `${c.path}`,
            // `effect`, not `detail`: detail is a GAPS field and the journal allowlist
            // drops it on a finding -- correctly, and silently, because the allowlist is
            // a security boundary rather than a validator.
            effect: c.winner
              ? `${c.winner.name} won with ${c.winner.value ?? '(no value)'}; also ` +
                `written by ${c.overridden.map((o) => o.name).join(', ')}`
              : 'no contribution is active: the annotation is in the chain and reaches ' +
                'nothing -- removing whatever neutralises it re-arms it',
            context: {
              annotation: c.path,
              winner: c.winner?.name,
              winnerValue: c.winner?.value,
              overriddenBy: c.overridden.map((o) => o.name).join(', '),
            },
          });
        }
      }

      return json(finish({
        entity: args.entity,
        element: args.element ?? null,
        counts: chain.counts,
        sources: chain.sources,
        annotations: chain.annotations,
        conflicts: chain.conflicts,
        // Once, as structure: the same list again as text was read twice by the model.
        ...(hiddenRole.length ? { hiddenWithUiRole: hiddenRole } : {}),
      }, []));
    },
  };
}

/**
 * A page of a verbatim payload, in characters: the next page asks the same GET again
 * (`costsCalls: 1`) and starts where this one ended.
 */
function payloadOf(body, offset = 0) {
  const from = Number.isInteger(offset) && offset > 0 ? Math.min(offset, body.length) : 0;
  const payload = body.slice(from, from + MAX_PAYLOAD);
  const end = from + payload.length;
  const truncated = end < body.length;
  return {
    payload,
    payloadPage: { chars: body.length, offset: from, returned: payload.length, limit: MAX_PAYLOAD, truncated, ...(truncated ? { next: { payloadOffset: end, costsCalls: 1 } } : {}) },
  };
}

const json = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
