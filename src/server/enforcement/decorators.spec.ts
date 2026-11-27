/**
 * @fileoverview The reflector keys of the enforcement decorators, pinned as the strings a host can read.
 * @layer server
 */
import { AI_FEATURE_METADATA, METER_METADATA, REQUIRE_BUDGET_METADATA } from './decorators'

describe('reflector metadata keys', () => {
  /** The keys are exported, so a host's own guard or discovery scan may read the metadata under these exact strings. */
  it.each([
    [METER_METADATA, 'bymax:ai-tokens:meter'],
    [REQUIRE_BUDGET_METADATA, 'bymax:ai-tokens:require-budget'],
    [AI_FEATURE_METADATA, 'bymax:ai-tokens:ai-feature'],
  ])('keeps the key %s', (key, expected) => {
    expect(key).toBe(expected)
  })
})
