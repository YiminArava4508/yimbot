// highlight.js 10 (pinned by cli-highlight) ships no GraphQL or HCL grammar,
// so these small definitions are registered on the shared hljs instance at
// import time. They aim at the tokens the review diff theme colors, not at
// full-language fidelity.
// hljs 10 declares HLJSApi, Language, and Mode as ambient globals.
import hljs from "highlight.js";

function graphql(api?: HLJSApi): Language {
  const h = api ?? hljs;
  return {
    name: "GraphQL",
    aliases: ["gql"],
    keywords: {
      keyword:
        "query mutation subscription type input schema directive interface union scalar " +
        "fragment enum on extend implements repeatable",
      literal: "true false null",
    },
    contains: [
      h.HASH_COMMENT_MODE,
      h.QUOTE_STRING_MODE,
      h.NUMBER_MODE,
      { className: "variable", begin: /\$\w+/, relevance: 0 },
      { className: "meta", begin: /@\w+/ },
      { className: "symbol", begin: /[_A-Za-z][_0-9A-Za-z]*(?=\s*(\(|:))/, relevance: 0 },
    ],
    illegal: [/[;<']/, /BEGIN/],
  };
}

function terraform(api?: HLJSApi): Language {
  const h = api ?? hljs;
  const interpolation: Mode = {
    className: "variable",
    begin: /\$\{/,
    end: /\}/,
    contains: [{ className: "string", begin: /"/, end: /"/ }],
  };
  const string: Mode = { className: "string", begin: /"/, end: /"/, contains: [interpolation] };
  return {
    name: "Terraform",
    aliases: ["tf", "hcl"],
    keywords: {
      keyword:
        "resource variable provider output locals module data terraform backend dynamic " +
        "lifecycle provisioner connection moved import check removed for in if",
      literal: "true false null",
    },
    contains: [
      h.HASH_COMMENT_MODE,
      h.C_LINE_COMMENT_MODE,
      h.C_BLOCK_COMMENT_MODE,
      h.NUMBER_MODE,
      string,
      { className: "built_in", begin: /\b(var|local|module|data|each|count|path|self|terraform)\./ },
      { className: "attr", begin: /\b[A-Za-z_][\w-]*(?=\s*=[^=])/, relevance: 0 },
    ],
  };
}

hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("terraform", terraform);
