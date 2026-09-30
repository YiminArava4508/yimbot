// Grammars the review diff can tokenize. Each import is one shiki TextMate
// grammar (with its embedded dependencies); only the languages mapped below
// are loaded so the highlighter stays small.
import type { LanguageRegistration } from "shiki/core";
import bash from "shiki/langs/bash.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import go from "shiki/langs/go.mjs";
import graphql from "shiki/langs/graphql.mjs";
import hcl from "shiki/langs/hcl.mjs";
import html from "shiki/langs/html.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import makefile from "shiki/langs/makefile.mjs";
import markdown from "shiki/langs/markdown.mjs";
import php from "shiki/langs/php.mjs";
import prisma from "shiki/langs/prisma.mjs";
import python from "shiki/langs/python.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import scss from "shiki/langs/scss.mjs";
import sql from "shiki/langs/sql.mjs";
import svelte from "shiki/langs/svelte.mjs";
import swift from "shiki/langs/swift.mjs";
import terraform from "shiki/langs/terraform.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import vue from "shiki/langs/vue.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";

export const GRAMMARS: LanguageRegistration[][] = [
  bash, c, cpp, csharp, css, dockerfile, go, graphql, hcl, html, ini, java, javascript, json, jsx,
  kotlin, makefile, markdown, php, prisma, python, ruby, rust, scss, sql, svelte, swift, terraform,
  toml, tsx, typescript, vue, xml, yaml,
];

const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash", json: "json", md: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", sql: "sql",
  css: "css", scss: "scss", html: "html", htm: "html", xml: "xml", svg: "xml",
  vue: "vue", svelte: "svelte", php: "php", prisma: "prisma",
  graphql: "graphql", gql: "graphql", tf: "terraform", tfvars: "terraform", hcl: "hcl",
  dockerfile: "dockerfile", mk: "makefile",
};

const NAME_LANG: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile" };

export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return NAME_LANG[base.toLowerCase()] ?? null;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? null;
}
