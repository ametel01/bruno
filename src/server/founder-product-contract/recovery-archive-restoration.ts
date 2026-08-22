import "server-only";

import type { FounderRecoveryArchiveDurableState } from "./recovery-archive-provider";

export type FounderRecoveryArchiveRestoreBoundary = {
  rebuild(state: FounderRecoveryArchiveDurableState): Promise<FounderRecoveryArchiveDurableState>;
};

export class IsolatedFounderRecoveryArchiveRestoreBoundary
  implements FounderRecoveryArchiveRestoreBoundary
{
  async rebuild(
    state: FounderRecoveryArchiveDurableState,
  ): Promise<FounderRecoveryArchiveDurableState> {
    const store = new IsolatedFounderRecoveryArchiveStore();
    store.insertOperator(state.operator);
    store.insertPreparation(state.operator.id, state.preparation);
    store.insertRuntime(state.operator.id, state.runtime);
    return store.rebuild(state.operator.id, state.restoration);
  }
}

class IsolatedFounderRecoveryArchiveStore {
  private operator: FounderRecoveryArchiveDurableState["operator"] | null = null;
  private preparation: FounderRecoveryArchiveDurableState["preparation"] | null = null;
  private runtime: FounderRecoveryArchiveDurableState["runtime"] | null = null;

  insertOperator(operator: FounderRecoveryArchiveDurableState["operator"]): void {
    this.operator = { ...operator };
  }

  insertPreparation(
    operatorId: string,
    preparation: FounderRecoveryArchiveDurableState["preparation"],
  ): void {
    this.requireOperator(operatorId);
    this.preparation = { ...preparation };
  }

  insertRuntime(operatorId: string, runtime: FounderRecoveryArchiveDurableState["runtime"]): void {
    this.requireOperator(operatorId);
    this.runtime = { ...runtime };
  }

  rebuild(
    operatorId: string,
    restoration: FounderRecoveryArchiveDurableState["restoration"],
  ): FounderRecoveryArchiveDurableState {
    const operator = this.requireOperator(operatorId);
    if (!this.preparation || !this.runtime || restoration.logicalOperatorId !== operatorId) {
      throw new Error("Recovery Archive could not rebuild a complete logical Operator.");
    }
    return {
      schemaVersion: 1,
      operator: { ...operator },
      preparation: { ...this.preparation },
      runtime: { ...this.runtime },
      restoration: {
        logicalOperatorId: restoration.logicalOperatorId,
        providerReauthorizationRequired: true,
        reusableCredentials: [],
      },
    };
  }

  private requireOperator(operatorId: string): FounderRecoveryArchiveDurableState["operator"] {
    if (!this.operator || this.operator.id !== operatorId) {
      throw new Error("Recovery Archive logical Operator identity is invalid.");
    }
    return this.operator;
  }
}
