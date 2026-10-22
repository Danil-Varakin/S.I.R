import { test } from 'node:test';
import assert from 'node:assert/strict';

import type * as wire from '../../src/service/protocol.ts';
import type * as resolve from '../../src/core/resolve.ts';
import type { SirHeader } from '../../src/core/ast.ts';
import type { SynthesisDraft, SynthesisFailure } from '../../src/core/errors.ts';
import type { PartialLimits, SynthLimits } from '../../src/generate/limits.ts';
import type { HunkWarning } from '../../src/generate/printer.ts';
import type { GenerateSettings } from '../../src/infra/config/index.ts';
import type { GitEol } from '../../src/infra/git.ts';
import type { Pair, PairReason } from '../../src/infra/pair.ts';

// R2: the wire types of src/service/protocol.ts are written out, not borrowed from the
// core — and held here equal to the core types the service fills them from. A change of
// a core type fails `npm run typecheck` on its line below: the protocol does not move
// with it silently. Change the wire type on purpose, with its protocol number and its row
// in VERSIONING.md, and this line agrees again.

/** Each assignable to the other: the same fields, the same types, nothing more on either
 *  side. `readonly` is no difference on the wire. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const sameAsTheCore: readonly true[] = [
  true satisfies Same<wire.Span, resolve.Span>,
  true satisfies Same<wire.LinkStatus, resolve.LinkStatus>,
  true satisfies Same<wire.LinkFailure, resolve.LinkFailure>,
  true satisfies Same<wire.HunkLink, resolve.HunkLink>,
  true satisfies Same<wire.ResolveResult, resolve.ResolveResult>,
  true satisfies Same<wire.SynthLimits, SynthLimits>,
  true satisfies Same<wire.PartialLimits, PartialLimits>,
  true satisfies Same<wire.GenerateSettings, GenerateSettings>,
  true satisfies Same<wire.GitEol, GitEol>,
  true satisfies Same<wire.HunkWarning, HunkWarning>,
  true satisfies Same<wire.PairReason, PairReason>,
  true satisfies Same<wire.PairResult, Pair>,
  true satisfies Same<wire.PatchHeader, SirHeader>,
  true satisfies Same<wire.SynthesisErrorDetail['reason'], SynthesisFailure>,
  true satisfies Same<NonNullable<wire.SynthesisErrorDetail['change']>, SynthesisDraft['change']>,
];

test('R2: every wire type of the protocol is the core type it is filled from (checked by the typecheck)', () => {
  assert.equal(sameAsTheCore.length, 15);
});
