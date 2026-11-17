/** A scriptable gateway for unit tests — no model, no process,
 * no network. Detector vocabulary, template, parsing, and degrade paths are
 * all testable through this. */

import type { Answer, ModelGateway, PredicateQuestion } from "./gateway.ts";

/** Builds answers for one call; throw a `GatewayError` to test the degrade
 * path, return a partial/reordered list to test parsing discipline. */
export type FakeResponder = (
  questions: PredicateQuestion[],
  text: string,
) => Answer[] | Promise<Answer[]>;

/** One recorded `ask` call. */
export interface FakeCall {
  questions: PredicateQuestion[];
  text: string;
}

export class TestFakeGateway implements ModelGateway {
  /** Every call in order, so tests can assert batching and inputs. */
  readonly calls: FakeCall[] = [];
  readonly #respond: FakeResponder;

  constructor(respond: FakeResponder = () => []) {
    this.#respond = respond;
  }

  async ask(questions: PredicateQuestion[], text: string): Promise<Answer[]> {
    this.calls.push({ questions, text });
    return this.#respond(questions, text);
  }
}
