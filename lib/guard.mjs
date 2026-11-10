// Read-only guard.
//
// The control is absence of capability, not validation: every ADT call goes through
// this proxy, and anything that is not on the allowlist throws before a request is
// issued.
//
// Why an allowlist and not a denylist. A denylist was the first design, and it was
// wrong in a way worth recording, because the mistake is easy to repeat: ADTClient
// declares 161 members in the 8.4.3 .d.ts (methods, getters and fields; count with
// `grep -oE '^\s{4}(static )?(get |set )?[a-zA-Z_]\w*\s*[(:<]' AdtClient.d.ts`),
// and four of them hand back an *unguarded* object that makes the whole list
// irrelevant --
//
//   httpClient      -> AdtHTTP with a generic request(url, config): the very
//                      "adt_http(method, path, body)" tool this design vetoed
//   statelessClone  -> a fresh ADTClient, not wrapped by this proxy, so .lock() works
//   createHttp      -> builds another AdtHTTP (TypeScript-private only; at runtime it
//                      sits on the prototype like any other method)
//   password        -> the plaintext SAP password (TypeScript-private, same story)
//
// A denylist also silently grows holes whenever the library adds a method. An
// allowlist fails closed instead: a new library method is unreachable until someone
// adds it here on purpose.
//
// Writing through ADT additionally requires locking the object first, so `lock` being
// absent from the allowlist is the effective brake.

/** Everything the tools and the session lifecycle actually need. Nothing else. */
const ALLOWED = new Set([
  // repository reads -- these are the tools
  'searchObject',
  'findObjectPath',
  'getObjectSource',
  'objectStructure',
  'objectStructureElements',
  'usageReferences',
  'usageReferenceSnippets',
  'nodeContents',
  // DDIC metadata reads. Added deliberately, and the reason is a measurement, not a
  // convenience: in a CDS projection a field inherits its type without restating it
  // (`key Plant,` and nothing more), objectStructureElements returns [] for a CDS
  // view, and a data element has no source at all (GET on its URI is a 404). So the
  // data element behind a projection field is NOT derivable from source text -- only
  // ddicElement answers it. Reading DDIC is reading the object catalogue, not
  // business data; all three are GETs and none of them needs a lock.
  'ddicElement',
  'annotationDefinitions',
  'ddicRepositoryAccess',
  // The data element and domain reads, added after measuring that ddicElement does
  // NOT close the loop: its elementProps carry ddicDataElement, ddicDataType,
  // ddicLength and the labels, but no domain. The domain is what a Z append field
  // matches on (ZDEMO_DE_MVGR1 has a Z data element and inherits domain MVGR1), so
  // without it that whole class of field has no concept to match. The documented
  // types say where it is: DataElementProperties.typeName plus searchHelp, and
  // DomainProperties.valueInformation.valueTableRef plus fixValues -- a domain with
  // fixed values needs no value help at all, which is a conclusion, not a gap.
  // (An earlier version of this file excluded getDataElementProperties on the claim
  // that ddicElement already covered it. That claim was untested and wrong.)
  'getDataElementProperties',
  'getDomainProperties',
  // The ADT service document: collections plus their URI templates, i.e. the only
  // authoritative description of this system's own REST parameters. SAP publishes no
  // endpoint reference; /sap/bc/adt/discovery is what it points to instead. Reading
  // it is how a parameter name gets verified rather than guessed.
  'adtDiscovery',
  // Enhancement implementations active on a source object. A GET
  // (/source/main/enhancements, Accept enhancements.v3+xml), no lock, no write.
  //
  // Added because it closes a gap an include-exit inventory DECLARES open, not to be tidy:
  // such an inventory lists the include exits, and their sibling -- enhancement spot and
  // implicit enhancement -- has the same invisibility problem and was never inventoried
  // for want of a way to extract it from the system. This is how it is extracted. Customer code living inside an
  // enhancement never appears in a Z-namespace sweep of the working tree, and no
  // abapGit repo serialises it against the standard object it modifies; the reply
  // names the ENHO, the enhancement-point path (\PR:<prog>\FO:<form>\SE:<sect>\EI),
  // whether it REPLACES the point, and the line of the base object it sits at.
  'objectEnhancements',
  // read-only introspection used for messages and diagnostics
  'baseUrl',
  'client',
  'language',
  'username',
  'loggedin',
  'isStateful',
  'sessionID',
]);

/** JS internals a Proxy must not throw on, or console.log / await breaks. */
const PASSTHROUGH = new Set(['then', 'constructor', 'toString', 'toJSON', 'inspect']);

/**
 * Write-capable members, listed only so the error message can say *why* something is
 * blocked, and so a reader of a future pull request sees the intent. The security
 * property comes from ALLOWED, not from this.
 */
const DENIED = new Set([
  // --- would modify the repository -------------------------------------------
  'lock', 'unLock', 'setObjectSource', 'createObject', 'deleteObject',
  'createTestInclude', 'setDomainProperties', 'setDataElementProperties',
  'setTextElements', 'setPrettyPrinterSetting',
  'renameEvaluate', 'renamePreview', 'renameExecute',
  'extractMethodEvaluate', 'extractMethodPreview', 'extractMethodExecute',
  'changePackagePreview', 'changePackageExecute',
  'fixEdits', 'activate', 'runClass',
  'publishServiceBinding', 'unPublishServiceBinding',
  // --- escape hatches: hand back an object this proxy does not guard ------------
  'httpClient', 'statelessClone', 'createHttp', 'password',
  // --- transport ---------------------------------------------------------------
  //
  // The seven below are writes and were never candidates. The two transport READS the
  // library offers -- `userTransports` and `transportDetails` -- are denied for a reason
  // that only measurement could give, so it is recorded here rather than assumed:
  //
  //   `userTransports` has three independent defects against this release, each of which
  //   alone produces AN EMPTY LIST WITH NO ERROR (measured, the development system). It sends
  //   no `Accept`, and the collection answers 200 with an empty root instead of the 406 a
  //   wrong Accept earns. It always sends `?user=&targets=`, and ANY query string on this
  //   collection empties the reply -- silently. And `parseTargets` navigates
  //   `tm:root > tm:workbench > tm:target`, an element that does not exist in the answer.
  //   A caller cannot tell that from "this user owns no transports", which is the exact
  //   silent-wrong answer this server exists to refuse.
  //
  //   `transportDetails` reads the request, but `parseTask`/`parseRequest` take only the
  //   DIRECT `tm:abap_object` children and never look at `tm:all_objects`. That is
  //   recoverable -- and it is recovered, deliberately, in lib/transport-requests.mjs.
  //
  // So both reads are served through the named-route GET table in lib/adt-get.mjs
  // instead, and ALLOWED does not grow. Admitting the methods would import their defects.
  'createTransport', 'transportDelete', 'transportRelease', 'transportSetOwner',
  'transportAddUser', 'setTransportsConfig', 'createTransportsConfig',
  // --- abapGit: pull/push belongs to the abapGit UI in the system ---------------
  'gitCreateRepo', 'gitPullRepo', 'gitUnlinkRepo', 'stageRepo', 'pushRepo',
  'switchRepoBranch',
  // --- ATC: the decision of 2026-09-08 was reversed for ONE run resource on 2026-09-14
  // (docs/security.md). The library methods stay denied: the run goes by lib/atc.mjs
  // (two fixed POSTs, closed variant set, one validated object URI) and the result by the
  // named GET route `atcWorklist` -- a route, not a client. Exemption proposals, requests
  // and contact changes are governance WRITES and are not admitted by any path.
  'atcCustomizing', 'atcCheckVariant', 'createAtcRun', 'atcWorklists',
  'atcExemptProposal', 'atcRequestExemption', 'atcChangeContact',
  // --- out of scope by decision: owned by the official SAP ADT MCP server -------
  'unitTestRun', 'unitTestEvaluation',
  'rapGenGenerate', 'rapGenPublishService',
  // --- out of scope for phase 1: business data, and a debugger on the system ----------
  'runQuery', 'tableContents',
  'debuggerListen', 'debuggerAttach', 'debuggerSetBreakpoints',
  'debuggerDeleteBreakpoints', 'debuggerStep', 'debuggerSetVariableValue',
  'debuggerSaveSettings', 'debuggerDeleteListener',
  // --- closed decision: traces, reading included (docs/security.md, 2026-11-10) -------
  'tracesCreateConfiguration', 'tracesDeleteConfiguration', 'tracesDelete',
  'tracesSetParameters',
]);

export class ReadOnlyViolation extends Error {
  constructor(method) {
    const why = DENIED.has(method)
      ? `It can change the SAP system, hand out an unguarded client, or belongs to the ` +
        `official SAP ADT MCP server (write path). Use the IDE for that.`
      : `This server exposes only the read methods its tools need; ` +
        `'${method}' is not one of them.`;
    super(`Blocked: '${method}' is not available in this server. ${why}`);
    this.name = 'ReadOnlyViolation';
    this.method = method;
  }
}

/** Wrap an ADTClient so that only allowlisted read methods can ever be reached. */
export function readOnly(client) {
  return new Proxy(client, {
    get(target, prop) {
      // Symbols are JS machinery (Symbol.toPrimitive, util.inspect.custom, ...).
      if (typeof prop === 'symbol') return Reflect.get(target, prop, target);
      if (!ALLOWED.has(prop) && !PASSTHROUGH.has(prop)) {
        throw new ReadOnlyViolation(prop);
      }
      // Receiver is the raw target, never the proxy: an allowed *getter* has to read
      // the client's own internal state, and routing that back through the proxy
      // would make it throw on its own private fields.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop) {
      // `stateful = 'stateful'` would enable locking. Refuse every assignment.
      throw new ReadOnlyViolation(String(prop));
    },
    deleteProperty(target, prop) {
      throw new ReadOnlyViolation(String(prop));
    },
    defineProperty(target, prop) {
      throw new ReadOnlyViolation(String(prop));
    },
    getPrototypeOf() {
      // Reaching the prototype would give back the unwrapped method table.
      return null;
    },
  });
}

export const allowedMethods = () => [...ALLOWED].sort();
export const deniedMethods = () => [...DENIED].sort();
