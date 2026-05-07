import {
  AckContractInputSchema,
  ContractRefreshInputSchema,
  TaskContractReadInputSchema,
  TaskContractWriteInputSchema,
} from '../schema';
import type { BusContext } from './index';
import { parse } from './parse';
import type { BusEvent } from '../state/events';
import type { StoredContract, ContractAck } from '../state/contracts';

export interface ContractHandlers {
  write(input: unknown): Promise<{ stored: StoredContract; event: BusEvent }>;
  read(input: unknown): Promise<{ stored: StoredContract }>;
  ack(input: unknown): Promise<{ ack: ContractAck; event: BusEvent }>;
  refresh(input: unknown): Promise<{ event: BusEvent }>;
}

export function createContractHandlers(
  ctx: Pick<BusContext, 'contracts' | 'events'>,
): ContractHandlers {
  return {
    async write(input) {
      const parsed = parse(TaskContractWriteInputSchema, input, 'task_contract.write');
      // Audit-then-state: events.append runs inside the contract file mutex,
      // before tmp+rename. Same invariant as lifecycle handlers.
      let event!: BusEvent;
      const stored = await ctx.contracts.write(parsed.contract, async () => {
        event = await ctx.events.append({
          type: 'contract_write',
          clone_id: parsed.contract.clone_id,
          payload: parsed.contract,
        });
      });
      return { stored, event };
    },

    async read(input) {
      const parsed = parse(TaskContractReadInputSchema, input, 'task_contract.read');
      const stored = await ctx.contracts.read(parsed.clone_id);
      return { stored };
    },

    async ack(input) {
      const parsed = parse(AckContractInputSchema, input, 'ack_contract');
      let event!: BusEvent;
      const ack = await ctx.contracts.ack(
        parsed.clone_id,
        parsed.interpretation,
        async () => {
          event = await ctx.events.append({
            type: 'contract_ack',
            clone_id: parsed.clone_id,
            payload: { interpretation: parsed.interpretation },
          });
        },
      );
      return { ack, event };
    },

    async refresh(input) {
      const parsed = parse(ContractRefreshInputSchema, input, 'contract_refresh');
      // refresh has no state mutation — it's a pure broadcast event. The
      // events log is itself the audit log; appending to it directly is the
      // atomic operation here. No coupling required.
      const event = await ctx.events.append({
        type: 'contract_refresh',
        payload: parsed.payload,
      });
      return { event };
    },
  };
}
