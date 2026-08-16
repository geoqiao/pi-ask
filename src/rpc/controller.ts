import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	emptyAnswer,
	isAnswerEmpty,
	saveCustomText,
	setSingleSelection,
} from "../state/answers.ts";
import { toAskResult } from "../state/result.ts";
import type {
	AskDisplayOption,
	AskQuestion,
	AskResult,
	AskState,
	AskStateAnswer,
} from "../types.ts";

type RpcUi = Pick<ExtensionContext["ui"], "input" | "select">;

interface RpcFlowOptions {
	signal?: AbortSignal;
}

type RpcQuestionResult =
	| { kind: "cancelled"; state: AskState }
	| { kind: "completed"; state: AskState };

interface SelectAction {
	kind: "custom" | "option";
	label: string;
	optionIndex?: number;
}

type SelectResult =
	| { kind: "aborted" }
	| { kind: "dismissed" }
	| { kind: "invalid" }
	| { action: SelectAction; kind: "selected" };

const TYPE_SOMETHING_LABEL = "Type something…";

export async function runRpcAskFlow(
	ctx: { ui: RpcUi },
	initialState: AskState,
	options: RpcFlowOptions = {}
): Promise<AskResult> {
	let state = initialState;

	for (const [questionIndex] of state.questions.entries()) {
		if (options.signal?.aborted) {
			return cancelledResult(state);
		}

		const step = await askQuestion(
			ctx.ui,
			state,
			questionIndex,
			options.signal
		);
		state = step.state;
		if (step.kind === "cancelled") {
			return cancelledResult(state);
		}
	}

	if (options.signal?.aborted) {
		return cancelledResult(state);
	}

	return toAskResult({
		...state,
		activeTabIndex: state.questions.length,
		completed: true,
	});
}

async function askQuestion(
	ui: RpcUi,
	state: AskState,
	questionIndex: number,
	signal?: AbortSignal
): Promise<RpcQuestionResult> {
	const question = state.questions[questionIndex];
	if (!question) {
		return { kind: "completed", state };
	}

	const actions = createQuestionActions(question);
	const selection = await selectAction(
		ui,
		formatTitle(state, question, questionIndex),
		actions,
		signal
	);

	if (selection.kind === "aborted" || selection.kind === "invalid") {
		return { kind: "cancelled", state };
	}
	if (selection.kind === "dismissed") {
		return {
			kind: "completed",
			state: clearAnswer(state, question.id),
		};
	}
	if (selection.action.kind === "custom") {
		return await askForCustomAnswer(ui, state, question, questionIndex, signal);
	}

	return selectOption(state, question, selection.action.optionIndex);
}

function createQuestionActions(question: AskQuestion): SelectAction[] {
	return [
		...[...question.options.entries()]
			.filter(([, option]) => !option.freeform)
			.map(([optionIndex, option]) => ({
				kind: "option" as const,
				label: formatOption(option, optionIndex),
				optionIndex,
			})),
		{ kind: "custom", label: TYPE_SOMETHING_LABEL },
	];
}

function selectOption(
	state: AskState,
	question: AskQuestion,
	optionIndex: number | undefined
): RpcQuestionResult {
	const option =
		optionIndex === undefined ? undefined : question.options[optionIndex];
	if (!option || optionIndex === undefined) {
		return { kind: "cancelled", state };
	}

	return {
		kind: "completed",
		state: updateAnswer(state, question.id, (answer) =>
			setSingleSelection(answer, option, optionIndex)
		),
	};
}

async function askForCustomAnswer(
	ui: RpcUi,
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	signal?: AbortSignal
): Promise<RpcQuestionResult> {
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}

	const value = await ui.input(
		formatTitle(state, question, questionIndex, TYPE_SOMETHING_LABEL),
		question.type === "multi"
			? "Enter one or more answers"
			: "Enter your answer",
		{ signal }
	);
	if (signal?.aborted) {
		return { kind: "cancelled", state };
	}
	if (value === undefined) {
		return {
			kind: "completed",
			state: clearAnswer(state, question.id),
		};
	}

	return {
		kind: "completed",
		state: updateAnswer(state, question.id, (answer) =>
			saveCustomText(answer, value, "single")
		),
	};
}

async function selectAction(
	ui: RpcUi,
	title: string,
	actions: SelectAction[],
	signal?: AbortSignal
): Promise<SelectResult> {
	if (signal?.aborted) {
		return { kind: "aborted" };
	}

	const selected = await ui.select(
		title,
		actions.map((action) => action.label),
		{ signal }
	);
	if (signal?.aborted) {
		return { kind: "aborted" };
	}
	if (selected === undefined) {
		return { kind: "dismissed" };
	}

	const action = actions.find((candidate) => candidate.label === selected);
	return action ? { action, kind: "selected" } : { kind: "invalid" };
}

function updateAnswer(
	state: AskState,
	questionId: string,
	mutate: (answer: AskStateAnswer) => AskStateAnswer
): AskState {
	const nextAnswer = mutate(state.answers[questionId] ?? emptyAnswer());
	const answers = { ...state.answers };
	if (isAnswerEmpty(nextAnswer)) {
		delete answers[questionId];
	} else {
		answers[questionId] = nextAnswer;
	}
	return { ...state, answers };
}

function clearAnswer(state: AskState, questionId: string): AskState {
	if (!state.answers[questionId]) {
		return state;
	}
	const answers = { ...state.answers };
	delete answers[questionId];
	return { ...state, answers };
}

function cancelledResult(state: AskState): AskResult {
	return toAskResult({
		...state,
		cancelled: true,
		completed: true,
	});
}

function formatTitle(
	state: AskState,
	question: AskQuestion,
	questionIndex: number,
	suffix?: string
): string {
	const progress = `[${questionIndex + 1}/${state.questions.length}]`;
	const flowTitle = state.title ? `${compactText(state.title)} — ` : "";
	const detail = suffix ? ` — ${suffix}` : "";
	return `${progress} ${flowTitle}${compactText(question.label)}: ${compactText(question.prompt)}${detail}`;
}

function formatOption(option: AskDisplayOption, optionIndex: number): string {
	const description = option.description
		? ` — ${compactText(option.description)}`
		: "";
	const preview = option.preview
		? ` — Preview: ${compactText(option.preview)}`
		: "";
	return `${optionIndex + 1}. ${compactText(option.label)}${description}${preview}`;
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
