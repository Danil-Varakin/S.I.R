// The one shape of a yes/no question in sir, whoever puts it and whoever answers:
// git's "a commit off the named branch — go ahead?", apply's "this loses local edits —
// go ahead?", generate -a's "keep this hunk?". What differs between them is the POLICY
// (the default answer, what no terminal means, whether --yes counts) — that lives with
// each caller; the shape and the way an exhausted input is reported live here once.

/** `true` goes ahead, `false` does not. */
export type Ask = (question: string) => Promise<boolean>;

/** Thrown by an Ask whose input closed before an answer came, where answering for the
 *  person would be a guess — `generate -a` stops rather than keep or drop hunks nobody
 *  looked at. A question that can lose work does not throw it: there, no answer is no. */
export class InputClosed extends Error {
  constructor() {
    super('input closed before an answer came');
    this.name = 'InputClosed';
  }
}
