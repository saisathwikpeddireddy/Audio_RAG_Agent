// The curated demo corpus every first-time visitor lands on, so the app is never
// an empty dropzone. Three famous, public-domain U.S. presidential recordings
// (works of the federal government), hosted on Wikimedia Commons. They're short
// enough to index in one function run, full of concrete facts to ask about, and
// different enough (a pep talk, an explainer, a warning) to show cross-source
// search. The suggested questions are hand-written and were checked against the
// transcripts so each one lands on a clear answer.

import { createHash } from "crypto";

export interface DemoSource {
  id: string; // stable file_id (also the Pinecone id prefix)
  title: string;
  filename: string;
  blurb: string; // one line shown under the demo banner
  credit: string;
  sourcePage: string; // human-readable page with provenance + license
  commonsFile: string; // Wikimedia file name (underscored DB key form)
  questions: string[];
}

export const DEMO_SOURCES: DemoSource[] = [
  {
    id: "demo-jfk-moon-1962",
    title: "JFK: We Choose to Go to the Moon (1962)",
    filename: "jfk-we-choose-to-go-to-the-moon-1962.mp3",
    blurb: "Kennedy at Rice University on why America is racing to the Moon.",
    credit: "Public domain (U.S. federal government work) via Wikimedia Commons",
    sourcePage:
      "https://commons.wikimedia.org/wiki/File:Jfk_rice_university_we_choose_to_go_to_the_moon.ogg",
    commonsFile: "Jfk_rice_university_we_choose_to_go_to_the_moon.ogg",
    questions: [
      "Why did Kennedy say we choose to go to the Moon?",
      "How much did he say the space program would cost?",
      "What role will Houston play in the space effort?",
    ],
  },
  {
    id: "demo-fdr-banking-1933",
    title: "FDR: Fireside Chat on the Banking Crisis (1933)",
    filename: "fdr-fireside-chat-banking-crisis-1933.mp3",
    blurb: "Roosevelt's first radio address, explaining why the banks were closed.",
    credit: "Public domain (U.S. federal government work) via Wikimedia Commons",
    sourcePage:
      "https://commons.wikimedia.org/wiki/File:Fireside_Chat_1_On_the_Banking_Crisis_(March_12,_1933)_Franklin_Delano_Roosevelt.ogg",
    commonsFile:
      "Fireside_Chat_1_On_the_Banking_Crisis_(March_12,_1933)_Franklin_Delano_Roosevelt.ogg",
    questions: [
      "Why did the banks have to close?",
      "Is money safer in a reopened bank or under the mattress?",
      "When and how will the banks reopen?",
    ],
  },
  {
    id: "demo-eisenhower-farewell-1961",
    title: "Eisenhower: Farewell Address (1961)",
    filename: "eisenhower-farewell-address-1961.mp3",
    blurb: "Eisenhower's warning about the military-industrial complex.",
    credit: "Public domain (U.S. federal government work) via Wikimedia Commons",
    sourcePage: "https://commons.wikimedia.org/wiki/File:Eisenhower_farewell_address.ogg",
    commonsFile: "Eisenhower_farewell_address.ogg",
    questions: [
      "What did Eisenhower warn about the military-industrial complex?",
      "What does he say about government funding of research?",
      "What does he say about living only for today?",
    ],
  },
];

// Direct download URLs for a Wikimedia file, best first. Files live under an md5
// hash path; the MP3 transcode plays everywhere (Safari can't play Ogg Vorbis),
// the original Ogg is the fallback. A file may be hosted on Commons or locally on
// English Wikipedia, so both are tried.
export function wikimediaCandidates(file: string): string[] {
  const md5 = createHash("md5").update(file).digest("hex");
  const hashPath = `${md5[0]}/${md5.slice(0, 2)}`;
  const enc = encodeURIComponent(file);
  const out: string[] = [];
  for (const wiki of ["commons", "en"]) {
    out.push(
      `https://upload.wikimedia.org/wikipedia/${wiki}/transcoded/${hashPath}/${enc}/${enc}.mp3`
    );
  }
  for (const wiki of ["commons", "en"]) {
    out.push(`https://upload.wikimedia.org/wikipedia/${wiki}/${hashPath}/${enc}`);
  }
  return out;
}
