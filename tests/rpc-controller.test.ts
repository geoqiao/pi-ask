import assert from "node:assert/strict";
import test from "node:test";
import { runRpcAskFlow } from "../src/rpc/controller.ts";
import { createInitialState } from "../src/state/create.ts";
import type { AskParams } from "../src/types.ts";

interface SelectCall {
	options: string[];
	signal?: AbortSignal;
	title: string;
}

interface InputCall {
	placeholder?: string;
	signal?: AbortSignal;
	title: string;
}

type SelectResponse =
	| string
	| undefined
	| ((call: SelectCall) => string | undefined);

type InputResponse =
	| string
	| undefined
	| ((call: InputCall) => string | undefined);

const TYPE_SOMETHING_LABEL = "Type something…";
const REMOVED_RPC_ACTIONS = [
	"Cancel ask",
	"Continue",
	"Finish selection",
	"More actions…",
	"Skip this question (optional)",
	"Skip this question (required is advisory)",
];

class RpcDialogHarness {
	readonly inputCalls: InputCall[] = [];
	readonly selectCalls: SelectCall[] = [];
	private readonly inputResponses: InputResponse[];
	private readonly selectResponses: SelectResponse[];

	constructor(
		selectResponses: SelectResponse[],
		inputResponses: InputResponse[] = []
	) {
		this.selectResponses = selectResponses;
		this.inputResponses = inputResponses;
	}

	readonly ctx = {
		ui: {
			input: (
				title: string,
				placeholder?: string,
				options?: { signal?: AbortSignal }
			) => {
				const call = { title, placeholder, signal: options?.signal };
				this.inputCalls.push(call);
				const response = this.shiftResponse(this.inputResponses, "input");
				return Promise.resolve(
					typeof response === "function" ? response(call) : response
				);
			},
			select: (
				title: string,
				options: string[],
				dialogOptions?: { signal?: AbortSignal }
			) => {
				assert.equal(
					new Set(options).size,
					options.length,
					"portable select options must be unique"
				);
				assert.equal(
					options.at(-1),
					TYPE_SOMETHING_LABEL,
					"every RPC question card must end with the sole custom action"
				);
				for (const removedAction of REMOVED_RPC_ACTIONS) {
					assert.equal(
						options.includes(removedAction),
						false,
						`${removedAction} must not appear on an RPC question card`
					);
				}
				const call = { title, options, signal: dialogOptions?.signal };
				this.selectCalls.push(call);
				const response = this.shiftResponse(this.selectResponses, "select");
				return Promise.resolve(
					typeof response === "function" ? response(call) : response
				);
			},
		},
	};

	assertDrained(): void {
		assert.equal(this.selectResponses.length, 0, "unused select responses");
		assert.equal(this.inputResponses.length, 0, "unused input responses");
	}

	private shiftResponse<T>(responses: T[], method: string): T {
		assert.notEqual(responses.length, 0, `unexpected ${method} dialog`);
		return responses.shift() as T;
	}
}

function pickOption(fragment: string): SelectResponse {
	return ({ options }) => {
		const option = options.find((candidate) => candidate.includes(fragment));
		assert(option, `missing option containing ${JSON.stringify(fragment)}`);
		return option;
	};
}

function params(questions: AskParams["questions"]): AskParams {
	return { title: "RPC interview", questions };
}

test("RPC single choice completes with one native select card", async () => {
	const harness = new RpcDialogHarness([pickOption("2. Safe")]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose a goal",
				options: [
					{ value: "fast", label: "Fast" },
					{ value: "safe", label: "Safe" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers.goal, {
		values: ["safe"],
		labels: ["Safe"],
		indices: [2],
		customText: undefined,
		note: undefined,
		optionNotes: undefined,
	});
	assert.deepEqual(harness.selectCalls[0]?.options, [
		"1. Fast",
		"2. Safe",
		TYPE_SOMETHING_LABEL,
	]);
	assert.equal(harness.selectCalls.length, 1);
	assert.equal(harness.inputCalls.length, 0);
	harness.assertDrained();
});

test("RPC preview flattens readable option details without extra cards", async () => {
	const harness = new RpcDialogHarness([pickOption("1. Compact")]);
	const state = createInitialState(
		params([
			{
				id: "layout",
				label: "Layout",
				prompt: "Which layout?",
				type: "preview",
				options: [
					{
						value: "compact",
						label: "Compact",
						description: "Dense controls",
						preview: "Line one\nLine two",
					},
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers.layout?.values, ["compact"]);
	assert.deepEqual(harness.selectCalls[0]?.options, [
		"1. Compact — Dense controls — Preview: Line one Line two",
		TYPE_SOMETHING_LABEL,
	]);
	assert.equal(harness.selectCalls.length, 1);
	harness.assertDrained();
});

test("RPC multiple questions advance directly after each submitted choice", async () => {
	const harness = new RpcDialogHarness([
		pickOption("1. Small"),
		pickOption("2. Friendly"),
	]);
	const state = createInitialState(
		params([
			{
				id: "scope",
				label: "Scope",
				prompt: "Pick scope",
				options: [{ value: "small", label: "Small" }],
			},
			{
				id: "tone",
				label: "Tone",
				prompt: "Pick tone",
				options: [
					{ value: "direct", label: "Direct" },
					{ value: "friendly", label: "Friendly" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.scope?.values, ["small"]);
	assert.deepEqual(result.answers.tone?.values, ["friendly"]);
	assert.equal(harness.selectCalls.length, 2);
	assert((harness.selectCalls[0]?.title ?? "").startsWith("[1/2]"));
	assert((harness.selectCalls[1]?.title ?? "").startsWith("[2/2]"));
	harness.assertDrained();
});

test("RPC Type something opens one input and preserves normalization", async () => {
	const harness = new RpcDialogHarness(
		[TYPE_SOMETHING_LABEL],
		["A custom answer"]
	);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "What is the goal?",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.goal, {
		values: ["A custom answer"],
		labels: ["A custom answer"],
		indices: [],
		customText: "A custom answer",
		note: undefined,
		optionNotes: undefined,
	});
	assert.equal(harness.selectCalls.length, 1);
	assert.equal(harness.inputCalls.length, 1);
	assert((harness.inputCalls[0]?.title ?? "").endsWith(TYPE_SOMETHING_LABEL));
	assert.equal(harness.inputCalls[0]?.placeholder, "Enter your answer");
	harness.assertDrained();
});

test("RPC multi questions accept one real option without a repeated-select loop", async () => {
	const harness = new RpcDialogHarness([pickOption("2. Beta")]);
	const state = createInitialState(
		params([
			{
				id: "features",
				prompt: "Which features?",
				type: "multi",
				options: [
					{ value: "alpha", label: "Alpha" },
					{ value: "beta", label: "Beta" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.features?.values, ["beta"]);
	assert.equal(result.questions[0]?.type, "multi");
	assert.deepEqual(harness.selectCalls[0]?.options, [
		"1. Alpha",
		"2. Beta",
		TYPE_SOMETHING_LABEL,
	]);
	assert.equal(harness.selectCalls.length, 1);
	harness.assertDrained();
});

test("RPC multi questions use Type something for multiple choices", async () => {
	const harness = new RpcDialogHarness(
		[TYPE_SOMETHING_LABEL],
		["Alpha, Gamma"]
	);
	const state = createInitialState(
		params([
			{
				id: "features",
				prompt: "Which features?",
				type: "multi",
				options: [
					{ value: "alpha", label: "Alpha" },
					{ value: "beta", label: "Beta" },
					{ value: "gamma", label: "Gamma" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.features, {
		values: ["Alpha, Gamma"],
		labels: ["Alpha, Gamma"],
		indices: [],
		customText: "Alpha, Gamma",
		note: undefined,
		optionNotes: undefined,
	});
	assert.equal(harness.inputCalls[0]?.placeholder, "Enter one or more answers");
	harness.assertDrained();
});

test("RPC question dismissal skips the current question and continues", async () => {
	const harness = new RpcDialogHarness([undefined, pickOption("1. Direct")]);
	const state = createInitialState(
		params([
			{
				id: "scope",
				prompt: "Pick scope",
				required: true,
				options: [{ value: "small", label: "Small" }],
			},
			{
				id: "tone",
				prompt: "Pick tone",
				options: [{ value: "direct", label: "Direct" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.equal(result.answers.scope, undefined);
	assert.deepEqual(result.answers.tone?.values, ["direct"]);
	assert.equal(harness.selectCalls.length, 2);
	harness.assertDrained();
});

test("RPC dismissal on the final question completes with no answer", async () => {
	const harness = new RpcDialogHarness([undefined]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC custom input dismissal skips the current question", async () => {
	const harness = new RpcDialogHarness(
		[TYPE_SOMETHING_LABEL, pickOption("1. Direct")],
		[undefined]
	);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
			{
				id: "tone",
				prompt: "Pick tone",
				options: [{ value: "direct", label: "Direct" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.equal(result.answers.goal, undefined);
	assert.deepEqual(result.answers.tone?.values, ["direct"]);
	harness.assertDrained();
});

test("RPC empty custom input completes as an unanswered question", async () => {
	const harness = new RpcDialogHarness([TYPE_SOMETHING_LABEL], ["   "]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, false);
	assert.equal(result.answers.goal, undefined);
	harness.assertDrained();
});

test("RPC keeps duplicate option labels selectable through numbered rows", async () => {
	const harness = new RpcDialogHarness([pickOption("2. Deploy")]);
	const state = createInitialState(
		params([
			{
				id: "target",
				prompt: "Choose target",
				options: [
					{ value: "primary", label: "Deploy" },
					{ value: "secondary", label: "Deploy" },
				],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.answers.target?.values, ["secondary"]);
	assert.deepEqual(result.answers.target?.indices, [2]);
	harness.assertDrained();
});

test("RPC propagates AbortSignal to select and treats abort as cancellation", async () => {
	const controller = new AbortController();
	const harness = new RpcDialogHarness([
		(call) => {
			assert.equal(call.signal, controller.signal);
			controller.abort();
			return;
		},
	]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state, {
		signal: controller.signal,
	});

	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC propagates AbortSignal to input and treats abort as cancellation", async () => {
	const controller = new AbortController();
	const harness = new RpcDialogHarness(
		[
			(call) => {
				assert.equal(call.signal, controller.signal);
				return TYPE_SOMETHING_LABEL;
			},
		],
		[
			(call) => {
				assert.equal(call.signal, controller.signal);
				controller.abort();
				return;
			},
		]
	);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state, {
		signal: controller.signal,
	});

	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC does not open a dialog when already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const harness = new RpcDialogHarness([]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state, {
		signal: controller.signal,
	});

	assert.equal(result.cancelled, true);
	assert.equal(harness.selectCalls.length, 0);
	harness.assertDrained();
});

test("RPC treats an unknown select response as cancellation", async () => {
	const harness = new RpcDialogHarness(["not one of the offered actions"]);
	const state = createInitialState(
		params([
			{
				id: "goal",
				prompt: "Choose",
				options: [{ value: "speed", label: "Speed" }],
			},
		])
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.equal(result.cancelled, true);
	assert.deepEqual(result.answers, {});
	harness.assertDrained();
});

test("RPC presentation overrides preserve requested and presented metadata", async () => {
	const harness = new RpcDialogHarness([pickOption("1. Stable")]);
	const state = createInitialState(
		params([
			{
				id: "api",
				prompt: "Choose API",
				type: "single",
				options: [{ value: "stable", label: "Stable" }],
			},
		]),
		{ presentSingleAsMulti: true }
	);

	const result = await runRpcAskFlow(harness.ctx, state);

	assert.deepEqual(result.questions, [
		{
			id: "api",
			label: "Q1",
			prompt: "Choose API",
			type: "single",
			presentedType: "multi",
		},
	]);
	assert.deepEqual(result.answers.api?.values, ["stable"]);
	assert.equal(harness.selectCalls.length, 1);
	harness.assertDrained();
});
