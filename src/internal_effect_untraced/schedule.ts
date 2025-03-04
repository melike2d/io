import * as Chunk from "@effect/data/Chunk"
import * as Context from "@effect/data/Context"
import * as Debug from "@effect/data/Debug"
import * as Duration from "@effect/data/Duration"
import * as Either from "@effect/data/Either"
import * as Equal from "@effect/data/Equal"
import type { LazyArg } from "@effect/data/Function"
import { constVoid, pipe } from "@effect/data/Function"
import * as Option from "@effect/data/Option"
import type { Predicate } from "@effect/data/Predicate"
import type * as Cause from "@effect/io/Cause"
import * as Clock from "@effect/io/Clock"
import type * as Effect from "@effect/io/Effect"
import * as internalCause from "@effect/io/internal_effect_untraced/cause"
import * as core from "@effect/io/internal_effect_untraced/core"
import * as effect from "@effect/io/internal_effect_untraced/effect"
import * as Random from "@effect/io/Random"
import * as Ref from "@effect/io/Ref"
import type * as Schedule from "@effect/io/Schedule"
import * as ScheduleDecision from "@effect/io/Schedule/Decision"
import * as Interval from "@effect/io/Schedule/Interval"
import * as Intervals from "@effect/io/Schedule/Intervals"

/** @internal */
const ScheduleSymbolKey = "@effect/io/Schedule"

/** @internal */
export const ScheduleTypeId: Schedule.ScheduleTypeId = Symbol.for(
  ScheduleSymbolKey
) as Schedule.ScheduleTypeId

/** @internal */
const ScheduleDriverSymbolKey = "@effect/io/Schedule/Driver"

/** @internal */
export const ScheduleDriverTypeId: Schedule.ScheduleDriverTypeId = Symbol.for(
  ScheduleDriverSymbolKey
) as Schedule.ScheduleDriverTypeId

/** @internal */
const scheduleVariance = {
  _Env: (_: never) => _,
  _In: (_: unknown) => _,
  _Out: (_: never) => _
}

const scheduleDriverVariance = {
  _Env: (_: never) => _,
  _In: (_: unknown) => _,
  _Out: (_: never) => _
}

/** @internal */
class ScheduleImpl<S, Env, In, Out> implements Schedule.Schedule<Env, In, Out> {
  [ScheduleTypeId] = scheduleVariance
  constructor(
    readonly initial: S,
    readonly step: (
      now: number,
      input: In,
      state: S
    ) => Effect.Effect<Env, never, readonly [S, Out, ScheduleDecision.ScheduleDecision]>
  ) {
  }
}

/** @internal */
class ScheduleDriverImpl<Env, In, Out> implements Schedule.ScheduleDriver<Env, In, Out> {
  [ScheduleDriverTypeId] = scheduleDriverVariance

  constructor(
    readonly schedule: Schedule.Schedule<Env, In, Out>,
    readonly ref: Ref.Ref<readonly [Option.Option<Out>, any]>
  ) {}

  state(): Effect.Effect<never, never, unknown> {
    return Debug.bodyWithTrace((trace) =>
      core.map(
        Ref.get(this.ref),
        (tuple) => tuple[1]
      ).traced(trace)
    )
  }

  last(): Effect.Effect<never, Cause.NoSuchElementException, Out> {
    return Debug.bodyWithTrace((trace) =>
      core.flatMap(Ref.get(this.ref), ([element, _]) => {
        switch (element._tag) {
          case "None": {
            return core.failSync(() => internalCause.NoSuchElementException())
          }
          case "Some": {
            return core.succeed(element.value)
          }
        }
      }).traced(trace)
    )
  }

  reset(): Effect.Effect<never, never, void> {
    return Debug.bodyWithTrace((trace) =>
      Ref.set(
        this.ref,
        [Option.none(), this.schedule.initial]
      ).traced(trace)
    )
  }

  next(input: In): Effect.Effect<Env, Option.Option<never>, Out> {
    return Debug.bodyWithTrace((trace, restore) =>
      pipe(
        core.map(Ref.get(this.ref), (tuple) => tuple[1]),
        core.flatMap((state) =>
          pipe(
            Clock.currentTimeMillis(),
            core.flatMap((now) =>
              pipe(
                core.suspend(restore(() => this.schedule.step(now, input, state))),
                core.flatMap(([state, out, decision]) =>
                  ScheduleDecision.isDone(decision) ?
                    pipe(
                      Ref.set(this.ref, [Option.some(out), state] as const),
                      core.zipRight(core.fail(Option.none()))
                    ) :
                    pipe(
                      Ref.set(this.ref, [Option.some(out), state] as const),
                      core.zipRight(effect.sleep(Duration.millis(Intervals.start(decision.intervals) - now))),
                      core.as(out)
                    )
                )
              )
            )
          )
        )
      ).traced(trace)
    )
  }
}

/** @internal */
export const makeWithState = Debug.untracedMethod((restore) =>
  <S, Env, In, Out>(
    initial: S,
    step: (
      now: number,
      input: In,
      state: S
    ) => Effect.Effect<Env, never, readonly [S, Out, ScheduleDecision.ScheduleDecision]>
  ): Schedule.Schedule<Env, In, Out> => new ScheduleImpl(initial, restore(step))
)

/** @internal */
export const addDelay = Debug.untracedDual<
  <Out>(
    f: (out: Out) => Duration.Duration
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Duration.Duration
  ) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => addDelayEffect(self, (out) => core.sync(() => restore(f)(out))))

/** @internal */
export const addDelayEffect = Debug.untracedDual<
  <Out, Env2>(
    f: (out: Out) => Effect.Effect<Env2, never, Duration.Duration>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Effect.Effect<Env2, never, Duration.Duration>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(2, (restore) =>
  (self, f) =>
    modifyDelayEffect(self, (out, duration) =>
      core.map(
        restore(f)(out),
        (delay) => Duration.millis(duration.millis + delay.millis)
      )))

/** @internal */
export const andThen = Debug.untracedDual<
  <Env1, In1, Out2>(
    that: Schedule.Schedule<Env1, In1, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env1,
    In & In1,
    Out | Out2
  >,
  <Env, In, Out, Env1, In1, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env1, In1, Out2>
  ) => Schedule.Schedule<
    Env | Env1,
    In & In1,
    Out | Out2
  >
>(2, () => (self, that) => pipe(andThenEither(self, that), map(Either.merge)))

/** @internal */
export const andThenEither = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    Either.Either<Out, Out2>
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    Either.Either<Out, Out2>
  >
>(2, (restore) =>
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ): Schedule.Schedule<
    Env | Env2,
    In & In2,
    Either.Either<Out, Out2>
  > =>
    makeWithState(
      [self.initial, that.initial, true as boolean] as const,
      (now, input, state) =>
        state[2] ?
          core.flatMap(restore(self.step)(now, input, state[0]), ([lState, out, decision]) => {
            if (ScheduleDecision.isDone(decision)) {
              return core.map(that.step(now, input, state[1]), ([rState, out, decision]) =>
                [
                  [lState, rState, false as boolean] as const,
                  Either.right(out) as Either.Either<Out, Out2>,
                  decision as ScheduleDecision.ScheduleDecision
                ] as const)
            }
            return core.succeed(
              [
                [lState, state[1], true as boolean] as const,
                Either.left(out),
                decision
              ] as const
            )
          }) :
          core.map(that.step(now, input, state[1]), ([rState, out, decision]) =>
            [
              [state[0], rState, false as boolean] as const,
              Either.right(out) as Either.Either<Out, Out2>,
              decision
            ] as const)
    ))

/** @internal */
export const as = Debug.untracedDual<
  <Out2>(out: Out2) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out2>,
  <Env, In, Out, Out2>(self: Schedule.Schedule<Env, In, Out>, out: Out2) => Schedule.Schedule<Env, In, Out2>
>(2, () => (self, out) => map(self, () => out))

/** @internal */
export const asUnit = Debug.untracedMethod(() =>
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ): Schedule.Schedule<Env, In, void> => map(self, constVoid)
)

/** @internal */
export const bothInOut = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    readonly [In, In2],
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<
    Env | Env2,
    readonly [In, In2],
    readonly [Out, Out2]
  >
>(
  2,
  (restore) =>
    (self, that) =>
      makeWithState([self.initial, that.initial] as const, (now, [in1, in2], state) =>
        core.zipWith(
          restore(self.step)(now, in1, state[0]),
          restore(that.step)(now, in2, state[1]),
          ([lState, out, lDecision], [rState, out2, rDecision]) => {
            if (ScheduleDecision.isContinue(lDecision) && ScheduleDecision.isContinue(rDecision)) {
              const interval = pipe(lDecision.intervals, Intervals.union(rDecision.intervals))
              return [
                [lState, rState] as const,
                [out, out2] as const,
                ScheduleDecision.continue(interval)
              ] as const
            }
            return [[lState, rState] as const, [out, out2] as const, ScheduleDecision.done] as const
          }
        ))
)

/** @internal */
export const check = Debug.untracedDual<
  <In, Out>(
    test: (input: In, output: Out) => boolean
  ) => <Env>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    test: (input: In, output: Out) => boolean
  ) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, test) => checkEffect(self, (input, out) => core.sync(() => restore(test)(input, out))))

/** @internal */
export const checkEffect = Debug.untracedDual<
  <In, Out, Env2>(
    test: (input: In, output: Out) => Effect.Effect<Env2, never, boolean>
  ) => <Env>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    test: (input: In, output: Out) => Effect.Effect<Env2, never, boolean>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(
  2,
  (restore) =>
    (self, test) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(restore(self.step)(now, input, state), ([state, out, decision]) => {
            if (ScheduleDecision.isDone(decision)) {
              return core.succeed([state, out, ScheduleDecision.done] as const)
            }
            return core.map(restore(test)(input, out), (cont) =>
              cont ?
                [state, out, decision] as const :
                [state, out, ScheduleDecision.done] as const)
          })
      )
)

/** @internal */
export const choose = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    Either.Either<In, In2>,
    Either.Either<Out, Out2>
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<
    Env | Env2,
    Either.Either<In, In2>,
    Either.Either<Out, Out2>
  >
>(2, (restore) =>
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ): Schedule.Schedule<
    Env | Env2,
    Either.Either<In, In2>,
    Either.Either<Out, Out2>
  > =>
    makeWithState(
      [self.initial, that.initial] as const,
      (now, either, state): Effect.Effect<
        Env | Env2,
        never,
        readonly [readonly [any, any], Either.Either<Out, Out2>, ScheduleDecision.ScheduleDecision]
      > => {
        switch (either._tag) {
          case "Left": {
            return core.map(
              restore(self.step)(now, either.left, state[0]),
              ([lState, out, decision]) => [[lState, state[1]] as const, Either.left(out), decision] as const
            )
          }
          case "Right": {
            return pipe(
              that.step(now, either.right, state[1]),
              core.map(([rState, out2, decision]) =>
                [[state[0], rState] as const, Either.right(out2), decision] as const
              )
            )
          }
        }
      }
    ))

/** @internal */
export const chooseMerge = Debug.untracedDual<
  <Env2, In2, Out2>(that: Schedule.Schedule<Env2, In2, Out2>) => <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ) => Schedule.Schedule<Env | Env2, Either.Either<In, In2>, Out | Out2>,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<Env | Env2, Either.Either<In, In2>, Out | Out2>
>(2, () => (self, that) => map(choose(self, that), Either.merge))

/** @internal */
export const collectAllInputs = Debug.untracedMethod(() =>
  <A>(): Schedule.Schedule<never, A, Chunk.Chunk<A>> => collectAllOutputs(identity<A>())
)

/** @internal */
export const collectAllOutputs = Debug.untracedMethod(() =>
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ): Schedule.Schedule<Env, In, Chunk.Chunk<Out>> =>
    reduce(self, Chunk.empty<Out>(), (outs, out) => pipe(outs, Chunk.append(out)))
)

/** @internal */
export const collectUntil = Debug.untracedMethod((restore) =>
  <A>(f: Predicate<A>): Schedule.Schedule<never, A, Chunk.Chunk<A>> => collectAllOutputs(recurUntil(restore(f)))
)

/** @internal */
export const collectUntilEffect = Debug.untracedMethod((restore) =>
  <Env, A>(
    f: (a: A) => Effect.Effect<Env, never, boolean>
  ): Schedule.Schedule<Env, A, Chunk.Chunk<A>> => collectAllOutputs(recurUntilEffect(restore(f)))
)

/** @internal */
export const collectWhile = Debug.untracedMethod((restore) =>
  <A>(f: Predicate<A>): Schedule.Schedule<never, A, Chunk.Chunk<A>> => collectAllOutputs(recurWhile(restore(f)))
)

/** @internal */
export const collectWhileEffect = Debug.untracedMethod((restore) =>
  <Env, A>(
    f: (a: A) => Effect.Effect<Env, never, boolean>
  ): Schedule.Schedule<Env, A, Chunk.Chunk<A>> => collectAllOutputs(recurWhileEffect(restore(f)))
)

/** @internal */
export const compose = Debug.untracedDual<
  <Env2, Out, Out2>(
    that: Schedule.Schedule<Env2, Out, Out2>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out2>,
  <Env, In, Out, Env2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, Out, Out2>
  ) => Schedule.Schedule<Env | Env2, In, Out2>
>(2, (restore) =>
  (self, that) =>
    makeWithState(
      [self.initial, that.initial] as const,
      (now, input, state) =>
        core.flatMap(
          restore(self.step)(now, input, state[0]),
          ([lState, out, lDecision]) =>
            core.map(that.step(now, out, state[1]), ([rState, out2, rDecision]) =>
              ScheduleDecision.isDone(lDecision)
                ? [[lState, rState] as const, out2, ScheduleDecision.done] as const
                : ScheduleDecision.isDone(rDecision)
                ? [[lState, rState] as const, out2, ScheduleDecision.done] as const
                : [
                  [lState, rState] as const,
                  out2,
                  ScheduleDecision.continue(pipe(lDecision.intervals, Intervals.max(rDecision.intervals)))
                ] as const)
        )
    ))

/** @internal */
export const contramap = Debug.untracedDual<
  <In, In2>(
    f: (in2: In2) => In
  ) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In2, Out>,
  <Env, In, Out, In2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (in2: In2) => In
  ) => Schedule.Schedule<Env, In2, Out>
>(2, (restore) => (self, f) => contramapEffect(self, (input2) => core.sync(() => restore(f)(input2))))

/** @internal */
export const contramapContext = Debug.untracedDual<
  <Env0, Env>(
    f: (env0: Context.Context<Env0>) => Context.Context<Env>
  ) => <In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env0, In, Out>,
  <Env0, Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (env0: Context.Context<Env0>) => Context.Context<Env>
  ) => Schedule.Schedule<Env0, In, Out>
>(2, (restore) =>
  (self, f) =>
    makeWithState(
      self.initial,
      (now, input, state) =>
        core.contramapContext(
          restore(self.step)(now, input, state),
          restore(f)
        )
    ))

/** @internal */
export const contramapEffect = Debug.untracedDual<
  <In, Env2, In2>(
    f: (in2: In2) => Effect.Effect<Env2, never, In>
  ) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In2, Out>,
  <Env, In, Out, Env2, In2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (in2: In2) => Effect.Effect<Env2, never, In>
  ) => Schedule.Schedule<Env | Env2, In2, Out>
>(2, (restore) =>
  (self, f) =>
    makeWithState(self.initial, (now, input2, state) =>
      core.flatMap(
        restore(f)(input2),
        (input) => restore(self.step)(now, input, state)
      )))

/** @internal */
export const count = Debug.untracedMethod(() =>
  (): Schedule.Schedule<never, unknown, number> => unfold(0, (n) => n + 1)
)

/** @internal */
export const dayOfMonth = Debug.untracedMethod(() =>
  (day: number): Schedule.Schedule<never, unknown, number> => {
    return makeWithState(
      [Number.NEGATIVE_INFINITY, 0] as readonly [number, number],
      (now, _, state) => {
        if (!Number.isInteger(day) || day < 1 || 31 < day) {
          return core.dieSync(() =>
            internalCause.IllegalArgumentException(
              `Invalid argument in: dayOfMonth(${day}). Must be in range 1...31`
            )
          )
        }
        const n = state[1]
        const initial = n === 0
        const day0 = nextDayOfMonth(now, day, initial)
        const start = beginningOfDay(day0)
        const end = endOfDay(day0)
        const interval = Interval.make(start, end)
        return core.succeed(
          [
            [end, n + 1] as const,
            n,
            ScheduleDecision.continueWith(interval)
          ] as const
        )
      }
    )
  }
)

/** @internal */
export const dayOfWeek = Debug.untracedMethod(() =>
  (day: number): Schedule.Schedule<never, unknown, number> => {
    return makeWithState(
      [Number.MIN_SAFE_INTEGER, 0] as readonly [number, number],
      (now, _, state) => {
        if (!Number.isInteger(day) || day < 1 || 7 < day) {
          return core.dieSync(() =>
            internalCause.IllegalArgumentException(
              `Invalid argument in: dayOfWeek(${day}). Must be in range 1 (Monday)...7 (Sunday)`
            )
          )
        }
        const n = state[1]
        const initial = n === 0
        const day0 = nextDay(now, day, initial)
        const start = beginningOfDay(day0)
        const end = endOfDay(day0)
        const interval = Interval.make(start, end)
        return core.succeed(
          [
            [end, n + 1] as const,
            n,
            ScheduleDecision.continueWith(interval)
          ] as const
        )
      }
    )
  }
)

/** @internal */
export const delayed = Debug.untracedDual<
  (
    f: (duration: Duration.Duration) => Duration.Duration
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (duration: Duration.Duration) => Duration.Duration
  ) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => delayedEffect(self, (duration) => core.sync(() => restore(f)(duration))))

/** @internal */
export const delayedEffect = Debug.untracedDual<
  <Env2>(
    f: (duration: Duration.Duration) => Effect.Effect<Env2, never, Duration.Duration>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (duration: Duration.Duration) => Effect.Effect<Env2, never, Duration.Duration>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(2, (restore) => (self, f) => modifyDelayEffect(self, (_, delay) => restore(f)(delay)))

/** @internal */
export const delayedSchedule = Debug.untracedMethod(() =>
  <Env, In>(
    schedule: Schedule.Schedule<Env, In, Duration.Duration>
  ): Schedule.Schedule<Env, In, Duration.Duration> => addDelay(schedule, (x) => x)
)

/** @internal */
export const delays = Debug.untracedMethod((restore) =>
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ): Schedule.Schedule<Env, In, Duration.Duration> =>
    makeWithState(self.initial, (now, input, state) =>
      pipe(
        restore(self.step)(now, input, state),
        core.flatMap((
          [state, _, decision]
        ): Effect.Effect<never, never, readonly [any, Duration.Duration, ScheduleDecision.ScheduleDecision]> => {
          if (ScheduleDecision.isDone(decision)) {
            return core.succeed([state, Duration.zero, decision] as const)
          }
          return core.succeed(
            [
              state,
              Duration.millis(Intervals.start(decision.intervals) - now),
              decision
            ] as const
          )
        })
      ))
)

/** @internal */
export const dimap = Debug.untracedDual<
  <In, Out, In2, Out2>(
    f: (in2: In2) => In,
    g: (out: Out) => Out2
  ) => <Env>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In2, Out2>,
  <Env, In, Out, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (in2: In2) => In,
    g: (out: Out) => Out2
  ) => Schedule.Schedule<Env, In2, Out2>
>(3, (restore) => (self, f, g) => pipe(contramap(self, restore(f)), map(restore(g))))

/** @internal */
export const dimapEffect = Debug.untracedDual<
  <In2, Env2, In, Out, Env3, Out2>(
    f: (input: In2) => Effect.Effect<Env2, never, In>,
    g: (out: Out) => Effect.Effect<Env3, never, Out2>
  ) => <Env>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2 | Env3, In2, Out2>,
  <Env, In, Out, In2, Env2, Env3, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (input: In2) => Effect.Effect<Env2, never, In>,
    g: (out: Out) => Effect.Effect<Env3, never, Out2>
  ) => Schedule.Schedule<Env | Env2 | Env3, In2, Out2>
>(3, (restore) => (self, f, g) => pipe(contramapEffect(self, restore(f)), mapEffect(restore(g))))

/** @internal */
export const driver = Debug.methodWithTrace((trace) =>
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ): Effect.Effect<never, never, Schedule.ScheduleDriver<Env, In, Out>> =>
    pipe(
      Ref.make<readonly [Option.Option<Out>, any]>([Option.none(), self.initial]),
      core.map((ref) => new ScheduleDriverImpl(self, ref))
    ).traced(trace)
)

/** @internal */
export const duration = Debug.untracedMethod(() =>
  (duration: Duration.Duration): Schedule.Schedule<never, unknown, Duration.Duration> =>
    makeWithState(true as boolean, (now, _, state) =>
      core.succeed(
        state
          ? [false, duration, ScheduleDecision.continueWith(Interval.after(now + duration.millis))] as const
          : [false, Duration.zero, ScheduleDecision.done] as const
      ))
)

/** @internal */
export const either = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >
>(2, () => (self, that) => union(self, that))

/** @internal */
export const eitherWith = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >
>(3, (restore) => (self, that, f) => unionWith(self, that, restore(f)))

/** @internal */
export const elapsed = Debug.untracedMethod(() =>
  (): Schedule.Schedule<never, unknown, Duration.Duration> =>
    makeWithState(Option.none() as Option.Option<number>, (now, _, state) => {
      switch (state._tag) {
        case "None": {
          return core.succeed(
            [
              Option.some(now),
              Duration.zero,
              ScheduleDecision.continueWith(Interval.after(now))
            ] as const
          )
        }
        case "Some": {
          return core.succeed(
            [
              Option.some(state.value),
              Duration.millis(now - state.value),
              ScheduleDecision.continueWith(Interval.after(now))
            ] as const
          )
        }
      }
    })
)

/** @internal */
export const ensuring = Debug.untracedDual<
  <X>(
    finalizer: Effect.Effect<never, never, X>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out, X>(
    self: Schedule.Schedule<Env, In, Out>,
    finalizer: Effect.Effect<never, never, X>
  ) => Schedule.Schedule<Env, In, Out>
>(
  2,
  (restore) =>
    (self, finalizer) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(restore(self.step)(now, input, state), ([state, out, decision]) =>
            ScheduleDecision.isDone(decision)
              ? core.as(finalizer, [state, out, decision as ScheduleDecision.ScheduleDecision] as const)
              : core.succeed([state, out, decision] as const))
      )
)

/** @internal */
export const exponential = Debug.untracedMethod(() =>
  (base: Duration.Duration, factor = 2.0): Schedule.Schedule<never, unknown, Duration.Duration> =>
    delayedSchedule(
      pipe(forever(), map((i) => Duration.millis(base.millis * Math.pow(factor, i))))
    )
)

/** @internal */
export const fibonacci = Debug.untracedMethod(() =>
  (one: Duration.Duration): Schedule.Schedule<never, unknown, Duration.Duration> =>
    delayedSchedule(
      pipe(
        unfold(
          [one, one] as const,
          ([a, b]) => [b, Duration.sum(a, b)] as const
        ),
        map((out) => out[0])
      )
    )
)

/** @internal */
export const fixed = Debug.untracedMethod(() =>
  (interval: Duration.Duration): Schedule.Schedule<never, unknown, number> =>
    makeWithState(
      [Option.none(), 0] as readonly [Option.Option<readonly [number, number]>, number],
      (now, _, [option, n]) =>
        core.sync(() => {
          const intervalMillis = interval.millis
          switch (option._tag) {
            case "None": {
              return [
                [Option.some([now, now + intervalMillis] as const), n + 1] as const,
                n,
                ScheduleDecision.continueWith(Interval.after(now + intervalMillis))
              ] as const
            }
            case "Some": {
              const [startMillis, lastRun] = option.value
              const runningBehind = now > (lastRun + intervalMillis)
              const boundary = Equal.equals(interval, Duration.zero)
                ? interval
                : Duration.millis(intervalMillis - ((now - startMillis) % intervalMillis))
              const sleepTime = Equal.equals(boundary, Duration.zero) ? interval : boundary
              const nextRun = runningBehind ? now : now + sleepTime.millis
              return [
                [Option.some([startMillis, nextRun] as const), n + 1] as const,
                n,
                ScheduleDecision.continueWith(Interval.after(nextRun))
              ] as const
            }
          }
        })
    )
)

/** @internal */
export const forever = Debug.untracedMethod(() =>
  (): Schedule.Schedule<never, unknown, number> => unfold(0, (n) => n + 1)
)

/** @internal */
export const fromDelay = Debug.untracedMethod(() =>
  (
    delay: Duration.Duration
  ): Schedule.Schedule<never, unknown, Duration.Duration> => duration(delay)
)

/** @internal */
export const fromDelays = Debug.untracedMethod(() =>
  (
    delay: Duration.Duration,
    ...delays: Array<Duration.Duration>
  ): Schedule.Schedule<never, unknown, Duration.Duration> =>
    makeWithState(
      [[delay, ...delays] as Array<Duration.Duration>, true as boolean] as const,
      (now, _, [durations, cont]) =>
        core.sync(() => {
          if (cont) {
            const x = durations[0]!
            const interval = Interval.after(now + x.millis)
            if (durations.length >= 2) {
              return [
                [durations.slice(1), true] as const,
                x,
                ScheduleDecision.continueWith(interval)
              ] as const
            }
            const y = durations.slice(1)
            return [
              [[x, ...y] as Array<Duration.Duration>, false] as const,
              x,
              ScheduleDecision.continueWith(interval)
            ] as const
          }
          return [[durations, false] as const, Duration.zero, ScheduleDecision.done] as const
        })
    )
)

/** @internal */
export const fromFunction = Debug.untracedMethod((restore) =>
  <A, B>(f: (a: A) => B): Schedule.Schedule<never, A, B> => pipe(identity<A>(), map(restore(f)))
)

/** @internal */
export const hourOfDay = Debug.untracedMethod(() =>
  (hour: number): Schedule.Schedule<never, unknown, number> =>
    makeWithState(
      [Number.NEGATIVE_INFINITY, 0] as readonly [number, number],
      (now, _, state) => {
        if (!Number.isInteger(hour) || hour < 0 || 23 < hour) {
          return core.dieSync(() =>
            internalCause.IllegalArgumentException(
              `Invalid argument in: hourOfDay(${hour}). Must be in range 0...23`
            )
          )
        }
        const n = state[1]
        const initial = n === 0
        const hour0 = nextHour(now, hour, initial)
        const start = beginningOfHour(hour0)
        const end = endOfHour(hour0)
        const interval = Interval.make(start, end)
        return core.succeed(
          [
            [end, n + 1] as const,
            n,
            ScheduleDecision.continueWith(interval)
          ] as const
        )
      }
    )
)

/** @internal */
export const identity = Debug.untracedMethod(() =>
  <A>(): Schedule.Schedule<never, A, A> =>
    makeWithState(void 0, (now, input, state) =>
      core.succeed(
        [
          state,
          input,
          ScheduleDecision.continueWith(Interval.after(now))
        ] as const
      ))
)

/** @internal */
export const intersect = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >
>(2, () =>
  (self, that) =>
    intersectWith(self, that, (selfIntervals, thatIntervals) =>
      pipe(
        selfIntervals,
        Intervals.intersect(thatIntervals)
      )))

/** @internal */
export const intersectWith = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >
>(
  3,
  (restore) =>
    <Env, In, Out, Env2, In2, Out2>(
      self: Schedule.Schedule<Env, In, Out>,
      that: Schedule.Schedule<Env2, In2, Out2>,
      f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
    ): Schedule.Schedule<
      Env | Env2,
      In & In2,
      readonly [Out, Out2]
    > =>
      makeWithState([self.initial, that.initial] as const, (now, input: In & In2, state) =>
        pipe(
          core.zipWith(
            restore(self.step)(now, input, state[0]),
            restore(that.step)(now, input, state[1]),
            (a, b) => [a, b] as const
          ),
          core.flatMap(([
            [lState, out, lDecision],
            [rState, out2, rDecision]
          ]) => {
            if (ScheduleDecision.isContinue(lDecision) && ScheduleDecision.isContinue(rDecision)) {
              return intersectWithLoop(
                self,
                that,
                input,
                lState,
                out,
                lDecision.intervals,
                rState,
                out2,
                rDecision.intervals,
                restore(f)
              )
            }
            return core.succeed(
              [
                [lState, rState] as const,
                [out, out2] as const,
                ScheduleDecision.done
              ] as const
            )
          })
        ))
)

/** @internal */
const intersectWithLoop = <State, State1, Env, In, Out, Env1, In1, Out2>(
  self: Schedule.Schedule<Env, In, Out>,
  that: Schedule.Schedule<Env1, In1, Out2>,
  input: In & In1,
  lState: State,
  out: Out,
  lInterval: Intervals.Intervals,
  rState: State1,
  out2: Out2,
  rInterval: Intervals.Intervals,
  f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
): Effect.Effect<
  Env | Env1,
  never,
  readonly [readonly [State, State1], readonly [Out, Out2], ScheduleDecision.ScheduleDecision]
> => {
  const combined = f(lInterval, rInterval)
  if (Intervals.isNonEmpty(combined)) {
    return core.succeed([
      [lState, rState],
      [out, out2],
      ScheduleDecision.continue(combined)
    ])
  }

  if (pipe(lInterval, Intervals.lessThan(rInterval))) {
    return core.flatMap(self.step(Intervals.end(lInterval), input, lState), ([lState, out, decision]) => {
      if (ScheduleDecision.isDone(decision)) {
        return core.succeed([
          [lState, rState],
          [out, out2],
          ScheduleDecision.done
        ])
      }
      return intersectWithLoop(
        self,
        that,
        input,
        lState,
        out,
        decision.intervals,
        rState,
        out2,
        rInterval,
        f
      )
    })
  }
  return core.flatMap(that.step(Intervals.end(rInterval), input, rState), ([rState, out2, decision]) => {
    if (ScheduleDecision.isDone(decision)) {
      return core.succeed([
        [lState, rState],
        [out, out2],
        ScheduleDecision.done
      ])
    }
    return intersectWithLoop(
      self,
      that,
      input,
      lState,
      out,
      lInterval,
      rState,
      out2,
      decision.intervals,
      f
    )
  })
}

/** @internal */
export const jittered = Debug.untracedMethod(() =>
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>): Schedule.Schedule<Env | Random.Random, In, Out> =>
    jitteredWith(self, { min: 0.8, max: 1.2 })
)

/** @internal */
export const jitteredWith = Debug.untracedDual<
  (options: { min?: number; max?: number }) => <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ) => Schedule.Schedule<Env | Random.Random, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    options: { min?: number; max?: number }
  ) => Schedule.Schedule<Env | Random.Random, In, Out>
>(2, () =>
  (self, options) => {
    const { max, min } = Object.assign({ min: 0.8, max: 1.2 }, options)
    return delayedEffect(self, (duration) =>
      core.map(Random.next(), (random) => {
        const d = duration.millis
        const jittered = d * min * (1 - random) + d * max * random
        return Duration.millis(jittered)
      }))
  })

/** @internal */
export const left = Debug.untracedMethod(() =>
  <Env, In, Out, X>(
    self: Schedule.Schedule<Env, In, Out>
  ): Schedule.Schedule<Env, Either.Either<In, X>, Either.Either<Out, X>> => choose(self, identity<X>())
)

/** @internal */
export const linear = Debug.untracedMethod(() =>
  (base: Duration.Duration): Schedule.Schedule<never, unknown, Duration.Duration> =>
    delayedSchedule(
      pipe(forever(), map((i) => Duration.millis(base.millis * (i + 1))))
    )
)

/** @internal */
export const map = Debug.untracedDual<
  <Out, Out2>(
    f: (out: Out) => Out2
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out2>,
  <Env, In, Out, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Out2
  ) => Schedule.Schedule<Env, In, Out2>
>(2, (restore) => (self, f) => mapEffect(self, (out) => core.sync(() => restore(f)(out))))

/** @internal */
export const mapEffect = Debug.untracedDual<
  <Out, Env2, Out2>(
    f: (out: Out) => Effect.Effect<Env2, never, Out2>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out2>,
  <Env, In, Out, Env2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Effect.Effect<Env2, never, Out2>
  ) => Schedule.Schedule<Env | Env2, In, Out2>
>(
  2,
  (restore) =>
    (self, f) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(restore(self.step)(now, input, state), ([state, out, decision]) =>
            core.map(
              restore(f)(out),
              (out2) => [state, out2, decision] as const
            ))
      )
)

/** @internal */
export const minuteOfHour = Debug.untracedMethod(() =>
  (minute: number): Schedule.Schedule<never, unknown, number> =>
    makeWithState(
      [Number.MIN_SAFE_INTEGER, 0] as readonly [number, number],
      (now, _, state) => {
        if (!Number.isInteger(minute) || minute < 0 || 59 < minute) {
          return core.dieSync(() =>
            internalCause.IllegalArgumentException(
              `Invalid argument in: minuteOfHour(${minute}). Must be in range 0...59`
            )
          )
        }
        const n = state[1]
        const initial = n === 0
        const minute0 = nextMinute(now, minute, initial)
        const start = beginningOfMinute(minute0)
        const end = endOfMinute(minute0)
        const interval = Interval.make(start, end)
        return core.succeed(
          [
            [end, n + 1],
            n,
            ScheduleDecision.continueWith(interval)
          ] as const
        )
      }
    )
)

/** @internal */
export const modifyDelay = Debug.untracedDual<
  <Out>(
    f: (out: Out, duration: Duration.Duration) => Duration.Duration
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out, duration: Duration.Duration) => Duration.Duration
  ) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => modifyDelayEffect(self, (out, duration) => core.sync(() => restore(f)(out, duration))))

/** @internal */
export const modifyDelayEffect = Debug.untracedDual<
  <Out, Env2>(
    f: (out: Out, duration: Duration.Duration) => Effect.Effect<Env2, never, Duration.Duration>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out, duration: Duration.Duration) => Effect.Effect<Env2, never, Duration.Duration>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(
  2,
  (restore) =>
    (self, f) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(restore(self.step)(now, input, state), ([state, out, decision]) => {
            if (ScheduleDecision.isDone(decision)) {
              return core.succeed([state, out, decision] as const)
            }
            const intervals = decision.intervals
            const delay = Interval.size(Interval.make(now, Intervals.start(intervals)))
            return core.map(restore(f)(out, delay), (duration) => {
              const oldStart = Intervals.start(intervals)
              const newStart = now + duration.millis
              const delta = newStart - oldStart
              const newEnd = Math.min(Math.max(0, Intervals.end(intervals) + delta), Number.MAX_SAFE_INTEGER)
              const newInterval = Interval.make(newStart, newEnd)
              return [state, out, ScheduleDecision.continueWith(newInterval)] as const
            })
          })
      )
)

/** @internal */
export const onDecision = Debug.untracedDual<
  <Out, Env2, X>(
    f: (out: Out, decision: ScheduleDecision.ScheduleDecision) => Effect.Effect<Env2, never, X>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2, X>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out, decision: ScheduleDecision.ScheduleDecision) => Effect.Effect<Env2, never, X>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(
  2,
  (restore) =>
    (self, f) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(
            restore(self.step)(now, input, state),
            ([state, out, decision]) => core.as(restore(f)(out, decision), [state, out, decision] as const)
          )
      )
)

/** @internal */
export const once = Debug.untracedMethod(() => (): Schedule.Schedule<never, unknown, void> => asUnit(recurs(1)))

/** @internal */
export const passthrough = Debug.untracedMethod((restore) =>
  <Env, Input, Output>(
    self: Schedule.Schedule<Env, Input, Output>
  ): Schedule.Schedule<Env, Input, Input> =>
    makeWithState(self.initial, (now, input, state) =>
      pipe(
        restore(self.step)(now, input, state),
        core.map(([state, _, decision]) => [state, input, decision] as const)
      ))
)

/** @internal */
export const provideContext = Debug.untracedDual<
  <Env>(
    context: Context.Context<Env>
  ) => <In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<never, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    context: Context.Context<Env>
  ) => Schedule.Schedule<never, In, Out>
>(2, (restore) =>
  (self, context) =>
    makeWithState(self.initial, (now, input, state) =>
      core.provideContext(
        restore(self.step)(now, input, state),
        context
      )))

/** @internal */
export const provideService = Debug.untracedDual<
  <T extends Context.Tag<any, any>>(
    tag: T,
    service: Context.Tag.Service<T>
  ) => <R, In, Out>(
    self: Schedule.Schedule<R, In, Out>
  ) => Schedule.Schedule<Exclude<R, Context.Tag.Identifier<T>>, In, Out>,
  <R, In, Out, T extends Context.Tag<any, any>>(
    self: Schedule.Schedule<R, In, Out>,
    tag: T,
    service: Context.Tag.Service<T>
  ) => Schedule.Schedule<Exclude<R, Context.Tag.Identifier<T>>, In, Out>
>(3, (restore) =>
  <R, In, Out, T extends Context.Tag<any, any>>(
    self: Schedule.Schedule<R, In, Out>,
    tag: T,
    service: Context.Tag.Service<T>
  ): Schedule.Schedule<Exclude<R, Context.Tag.Identifier<T>>, In, Out> =>
    makeWithState(self.initial, (now, input, state) =>
      core.contextWithEffect<
        Exclude<R, Context.Tag.Identifier<T>>,
        Exclude<R, Context.Tag.Identifier<T>>,
        never,
        readonly [any, Out, ScheduleDecision.ScheduleDecision]
      >((env) =>
        core.provideContext(
          // @ts-expect-error
          restore(self.step)(now, input, state),
          pipe(env, Context.add(tag, service))
        )
      )))

/** @internal */
export const reconsider = Debug.untracedDual<
  <Out, Out2>(
    f: (
      out: Out,
      decision: ScheduleDecision.ScheduleDecision
    ) => Either.Either<Out2, readonly [Out2, Interval.Interval]>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out2>,
  <Env, In, Out, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (
      out: Out,
      decision: ScheduleDecision.ScheduleDecision
    ) => Either.Either<Out2, readonly [Out2, Interval.Interval]>
  ) => Schedule.Schedule<Env, In, Out2>
>(2, (restore) => (self, f) => reconsiderEffect(self, (out, decision) => core.sync(() => restore(f)(out, decision))))

/** @internal */
export const reconsiderEffect = Debug.untracedDual<
  <Out, Env2, Out2>(
    f: (
      out: Out,
      decision: ScheduleDecision.ScheduleDecision
    ) => Effect.Effect<Env2, never, Either.Either<Out2, readonly [Out2, Interval.Interval]>>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out2>,
  <Env, In, Out, Env2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (
      out: Out,
      decision: ScheduleDecision.ScheduleDecision
    ) => Effect.Effect<Env2, never, Either.Either<Out2, readonly [Out2, Interval.Interval]>>
  ) => Schedule.Schedule<Env | Env2, In, Out2>
>(
  2,
  (restore) =>
    (self, f) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(restore(self.step)(now, input, state), ([state, out, decision]) =>
            ScheduleDecision.isDone(decision)
              ? core.map(restore(f)(out, decision), (either) => {
                switch (either._tag) {
                  case "Left": {
                    return [state, either.left, ScheduleDecision.done] as const
                  }
                  case "Right": {
                    const [out2] = either.right
                    return [state, out2, ScheduleDecision.done] as const
                  }
                }
              })
              : core.map(restore(f)(out, decision), (either) => {
                switch (either._tag) {
                  case "Left": {
                    return [state, either.left, ScheduleDecision.done] as const
                  }
                  case "Right": {
                    const [out2, interval] = either.right
                    return [state, out2, ScheduleDecision.continueWith(interval)] as const
                  }
                }
              }))
      )
)

/** @internal */
export const recurUntil = Debug.untracedMethod((restore) =>
  <A>(f: Predicate<A>): Schedule.Schedule<never, A, A> => untilInput(identity<A>(), restore(f))
)

/** @internal */
export const recurUntilEffect = Debug.untracedMethod((restore) =>
  <Env, A>(
    f: (a: A) => Effect.Effect<Env, never, boolean>
  ): Schedule.Schedule<Env, A, A> => untilInputEffect(identity<A>(), restore(f))
)

/** @internal */
export const recurUntilEquals = Debug.untracedMethod(() =>
  <A>(value: A): Schedule.Schedule<never, A, A> => untilInput(identity<A>(), (input) => Equal.equals(input, value))
)

/** @internal */
export const recurUntilOption = Debug.untracedMethod((restore) =>
  <A, B>(pf: (a: A) => Option.Option<B>): Schedule.Schedule<never, A, Option.Option<B>> =>
    pipe(
      identity<A>(),
      map(restore(pf)),
      untilOutput(Option.isSome)
    )
)

/** @internal */
export const recurUpTo = Debug.untracedMethod(() =>
  (duration: Duration.Duration): Schedule.Schedule<never, unknown, Duration.Duration> =>
    whileOutput(elapsed(), (elapsed) => pipe(elapsed, Duration.lessThan(duration)))
)

/** @internal */
export const recurWhile = Debug.untracedMethod((restore) =>
  <A>(f: Predicate<A>): Schedule.Schedule<never, A, A> => whileInput(identity<A>(), restore(f))
)

/** @internal */
export const recurWhileEffect = Debug.untracedMethod((restore) =>
  <Env, A>(f: (a: A) => Effect.Effect<Env, never, boolean>): Schedule.Schedule<Env, A, A> =>
    whileInputEffect(identity<A>(), restore(f))
)

/** @internal */
export const recurWhileEquals = Debug.untracedMethod(() =>
  <A>(value: A): Schedule.Schedule<never, A, A> =>
    pipe(
      identity<A>(),
      whileInput((input) => Equal.equals(input, value))
    )
)

/** @internal */
export const recurs = Debug.untracedMethod(() =>
  (n: number): Schedule.Schedule<never, unknown, number> => whileOutput(forever(), (out) => out < n)
)

/** @internal */
export const reduce = Debug.untracedDual<
  <Out, Z>(
    zero: Z,
    f: (z: Z, out: Out) => Z
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Z>,
  <Env, In, Out, Z>(
    self: Schedule.Schedule<Env, In, Out>,
    zero: Z,
    f: (z: Z, out: Out) => Z
  ) => Schedule.Schedule<Env, In, Z>
>(3, (restore) => (self, zero, f) => reduceEffect(self, zero, (z, out) => core.sync(() => restore(f)(z, out))))

/** @internal */
export const reduceEffect = Debug.untracedDual<
  <Out, Env1, Z>(
    zero: Z,
    f: (z: Z, out: Out) => Effect.Effect<Env1, never, Z>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env1, In, Z>,
  <Env, In, Out, Env1, Z>(
    self: Schedule.Schedule<Env, In, Out>,
    zero: Z,
    f: (z: Z, out: Out) => Effect.Effect<Env1, never, Z>
  ) => Schedule.Schedule<Env | Env1, In, Z>
>(
  3,
  (restore) =>
    (self, zero, f) =>
      makeWithState(
        [self.initial, zero] as const,
        (now, input, [s, z]) =>
          core.flatMap(restore(self.step)(now, input, s), ([s, out, decision]) =>
            ScheduleDecision.isDone(decision)
              ? core.succeed([[s, z], z, decision as ScheduleDecision.ScheduleDecision] as const)
              : core.map(restore(f)(z, out), (z2) => [[s, z2], z, decision] as const))
      )
)

/** @internal */
export const repeatForever = Debug.untracedMethod((restore) =>
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>): Schedule.Schedule<Env, In, Out> =>
    makeWithState(self.initial, (now, input, state) => {
      const step = (
        now: number,
        input: In,
        state: any
      ): Effect.Effect<Env, never, readonly [any, Out, ScheduleDecision.ScheduleDecision]> =>
        core.flatMap(
          restore(self.step)(now, input, state),
          ([state, out, decision]) =>
            ScheduleDecision.isDone(decision)
              ? step(now, input, self.initial)
              : core.succeed([state, out, decision])
        )
      return step(now, input, state)
    })
)

/** @internal */
export const repetitions = Debug.untracedMethod(() =>
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>): Schedule.Schedule<Env, In, number> =>
    reduce(self, 0, (n, _) => n + 1)
)

/** @internal */
export const resetAfter = Debug.untracedDual<
  (
    duration: Duration.Duration
  ) => <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    duration: Duration.Duration
  ) => Schedule.Schedule<Env, In, Out>
>(2, () =>
  (self, duration) =>
    pipe(
      self,
      intersect(elapsed()),
      resetWhen(([, time]) => pipe(time, Duration.greaterThanOrEqualTo(duration))),
      map((out) => out[0])
    ))

/** @internal */
export const resetWhen = Debug.untracedDual<
  <Out>(f: Predicate<Out>) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>, f: Predicate<Out>) => Schedule.Schedule<Env, In, Out>
>(
  2,
  (restore) =>
    (self, f) =>
      makeWithState(
        self.initial,
        (now, input, state) =>
          core.flatMap(restore(self.step)(now, input, state), ([state, out, decision]) =>
            restore(f)(out)
              ? restore(self.step)(now, input, self.initial)
              : core.succeed([state, out, decision] as const))
      )
)

/** @internal */
export const right = Debug.untracedMethod(() =>
  <Env, In, Out, X>(
    self: Schedule.Schedule<Env, In, Out>
  ): Schedule.Schedule<Env, Either.Either<X, In>, Either.Either<X, Out>> => choose(identity<X>(), self)
)

/** @internal */
export const run = Debug.dualWithTrace<
  <In>(
    now: number,
    input: Iterable<In>
  ) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Effect.Effect<Env, never, Chunk.Chunk<Out>>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    now: number,
    input: Iterable<In>
  ) => Effect.Effect<Env, never, Chunk.Chunk<Out>>
>(3, (trace) =>
  (self, now, input) =>
    pipe(
      runLoop(self, now, Chunk.fromIterable(input), self.initial, Chunk.empty()),
      core.map((list) => Chunk.reverse(list))
    ).traced(trace))

/** @internal */
const runLoop = <Env, In, Out>(
  self: Schedule.Schedule<Env, In, Out>,
  now: number,
  inputs: Chunk.Chunk<In>,
  state: any,
  acc: Chunk.Chunk<Out>
): Effect.Effect<Env, never, Chunk.Chunk<Out>> => {
  if (!Chunk.isNonEmpty(inputs)) {
    return core.succeed(acc)
  }
  const input = Chunk.headNonEmpty(inputs)
  const nextInputs = Chunk.tailNonEmpty(inputs)
  return core.flatMap(self.step(now, input, state), ([state, out, decision]) => {
    if (ScheduleDecision.isDone(decision)) {
      return core.sync(() => pipe(acc, Chunk.prepend(out)))
    }
    return runLoop(
      self,
      Intervals.start(decision.intervals),
      nextInputs,
      state,
      pipe(acc, Chunk.prepend(out))
    )
  })
}

/** @internal */
export const secondOfMinute = Debug.untracedMethod(() =>
  (second: number): Schedule.Schedule<never, unknown, number> =>
    makeWithState(
      [Number.NEGATIVE_INFINITY, 0] as readonly [number, number],
      (now, _, state) => {
        if (!Number.isInteger(second) || second < 0 || 59 < second) {
          return core.dieSync(() =>
            internalCause.IllegalArgumentException(
              `Invalid argument in: secondOfMinute(${second}). Must be in range 0...59`
            )
          )
        }
        const n = state[1]
        const initial = n === 0
        const second0 = nextSecond(now, second, initial)
        const start = beginningOfSecond(second0)
        const end = endOfSecond(second0)
        const interval = Interval.make(start, end)
        return core.succeed(
          [
            [end, n + 1],
            n,
            ScheduleDecision.continueWith(interval)
          ] as const
        )
      }
    )
)

/** @internal */
export const spaced = Debug.untracedMethod(() =>
  (duration: Duration.Duration): Schedule.Schedule<never, unknown, number> => addDelay(forever(), () => duration)
)

/** @internal */
export const stop = Debug.untracedMethod(() => (): Schedule.Schedule<never, unknown, void> => asUnit(recurs(0)))

/** @internal */
export const succeed = Debug.untracedMethod(() =>
  <A>(value: A): Schedule.Schedule<never, unknown, A> => map(forever(), () => value)
)

/** @internal */
export const sync = Debug.untracedMethod((restore) =>
  <A>(evaluate: LazyArg<A>): Schedule.Schedule<never, unknown, A> => map(forever(), restore(evaluate))
)

/** @internal */
export const tapInput = Debug.untracedDual<
  <Env2, In2, X>(
    f: (input: In2) => Effect.Effect<Env2, never, X>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In & In2, Out>,
  <Env, In, Out, Env2, In2, X>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (input: In2) => Effect.Effect<Env2, never, X>
  ) => Schedule.Schedule<Env | Env2, In & In2, Out>
>(2, (restore) =>
  (self, f) =>
    makeWithState(self.initial, (now, input, state) =>
      core.zipRight(
        restore(f)(input),
        restore(self.step)(now, input, state)
      )))

/** @internal */
export const tapOutput = Debug.untracedDual<
  <Out, Env2, X>(
    f: (out: Out) => Effect.Effect<Env2, never, X>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2, X>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Effect.Effect<Env2, never, X>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(2, (restore) =>
  (self, f) =>
    makeWithState(self.initial, (now, input, state) =>
      core.tap(
        restore(self.step)(now, input, state),
        ([, out]) => restore(f)(out)
      )))

/** @internal */
export const unfold = Debug.untracedMethod((restore) =>
  <A>(
    initial: A,
    f: (a: A) => A
  ): Schedule.Schedule<never, unknown, A> =>
    makeWithState(initial, (now, _, state) =>
      core.sync(() =>
        [
          restore(f)(state),
          state,
          ScheduleDecision.continueWith(Interval.after(now))
        ] as const
      ))
)

/** @internal */
export const union = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >
>(2, () =>
  (self, that) =>
    unionWith(self, that, (selfIntervals, thatIntervals) =>
      pipe(
        selfIntervals,
        Intervals.union(thatIntervals)
      )))

/** @internal */
export const unionWith = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (x: Intervals.Intervals, y: Intervals.Intervals) => Intervals.Intervals
  ) => Schedule.Schedule<
    Env | Env2,
    In & In2,
    readonly [Out, Out2]
  >
>(
  3,
  (restore) =>
    (self, that, f) =>
      makeWithState([self.initial, that.initial] as const, (now, input, state) =>
        core.zipWith(
          restore(self.step)(now, input, state[0]),
          restore(that.step)(now, input, state[1]),
          ([lState, l, lDecision], [rState, r, rDecision]) => {
            if (ScheduleDecision.isDone(lDecision) && ScheduleDecision.isDone(rDecision)) {
              return [[lState, rState] as const, [l, r] as const, ScheduleDecision.done] as const
            }
            if (ScheduleDecision.isDone(lDecision) && ScheduleDecision.isContinue(rDecision)) {
              return [
                [lState, rState] as const,
                [l, r] as const,
                ScheduleDecision.continue(rDecision.intervals)
              ] as const
            }
            if (ScheduleDecision.isContinue(lDecision) && ScheduleDecision.isDone(rDecision)) {
              return [
                [lState, rState] as const,
                [l, r],
                ScheduleDecision.continue(lDecision.intervals)
              ] as const
            }
            if (ScheduleDecision.isContinue(lDecision) && ScheduleDecision.isContinue(rDecision)) {
              const combined = restore(f)(lDecision.intervals, rDecision.intervals)
              return [
                [lState, rState] as const,
                [l, r],
                ScheduleDecision.continue(combined)
              ] as const
            }
            throw new Error(
              "BUG: Schedule.unionWith - please report an issue at https://github.com/Effect-TS/io/issues"
            )
          }
        ))
)

/** @internal */
export const untilInput = Debug.untracedDual<
  <In>(f: Predicate<In>) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>, f: Predicate<In>) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => check(self, (input, _) => !restore(f)(input)))

/** @internal */
export const untilInputEffect = Debug.untracedDual<
  <In, Env2>(
    f: (input: In) => Effect.Effect<Env2, never, boolean>
  ) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (input: In) => Effect.Effect<Env2, never, boolean>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(2, (restore) => (self, f) => checkEffect(self, (input, _) => effect.negate(restore(f)(input))))

/** @internal */
export const untilOutput = Debug.untracedDual<
  <Out>(f: Predicate<Out>) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>, f: Predicate<Out>) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => check(self, (_, out) => !restore(f)(out)))

/** @internal */
export const untilOutputEffect = Debug.untracedDual<
  <Out, Env2>(
    f: (out: Out) => Effect.Effect<Env2, never, boolean>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Effect.Effect<Env2, never, boolean>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(2, (restore) => (self, f) => checkEffect(self, (_, out) => effect.negate(restore(f)(out))))

/** @internal */
export const upTo = Debug.untracedDual<
  (duration: Duration.Duration) => <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>
  ) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(
    self: Schedule.Schedule<Env, In, Out>,
    duration: Duration.Duration
  ) => Schedule.Schedule<Env, In, Out>
>(2, () => (self, duration) => zipLeft(self, recurUpTo(duration)))

/** @internal */
export const whileInput = Debug.untracedDual<
  <In>(f: Predicate<In>) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>, f: Predicate<In>) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => check(self, (input, _) => restore(f)(input)))

/** @internal */
export const whileInputEffect = Debug.untracedDual<
  <In, Env2>(
    f: (input: In) => Effect.Effect<Env2, never, boolean>
  ) => <Env, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In, Out>,
  <Env, In, Out, Env2>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (input: In) => Effect.Effect<Env2, never, boolean>
  ) => Schedule.Schedule<Env | Env2, In, Out>
>(2, (restore) => (self, f) => checkEffect(self, (input, _) => restore(f)(input)))

/** @internal */
export const whileOutput = Debug.untracedDual<
  <Out>(f: Predicate<Out>) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env, In, Out>,
  <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>, f: Predicate<Out>) => Schedule.Schedule<Env, In, Out>
>(2, (restore) => (self, f) => check(self, (_, out) => restore(f)(out)))

/** @internal */
export const whileOutputEffect = Debug.untracedDual<
  <Out, Env1>(
    f: (out: Out) => Effect.Effect<Env1, never, boolean>
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env1, In, Out>,
  <Env, In, Out, Env1>(
    self: Schedule.Schedule<Env, In, Out>,
    f: (out: Out) => Effect.Effect<Env1, never, boolean>
  ) => Schedule.Schedule<Env | Env1, In, Out>
>(2, (restore) => (self, f) => checkEffect(self, (_, out) => restore(f)(out)))

/** @internal */
export const windowed = Debug.untracedMethod(() =>
  (interval: Duration.Duration): Schedule.Schedule<never, unknown, number> => {
    const millis = interval.millis
    return makeWithState(
      [Option.none(), 0] as readonly [Option.Option<number>, number],
      (now, _, [option, n]) => {
        switch (option._tag) {
          case "None": {
            return core.succeed(
              [
                [Option.some(now), n + 1],
                n,
                ScheduleDecision.continueWith(Interval.after(now + millis))
              ] as const
            )
          }
          case "Some": {
            return core.succeed(
              [
                [Option.some(option.value), n + 1],
                n,
                ScheduleDecision.continueWith(
                  Interval.after(now + (millis - ((now - option.value) % millis)))
                )
              ] as const
            )
          }
        }
      }
    )
  }
)

/** @internal */
export const zipLeft = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In & In2, Out>,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<Env | Env2, In & In2, Out>
>(2, () => (self, that) => pipe(intersect(self, that), map((out) => out[0])))

/** @internal */
export const zipRight = Debug.untracedDual<
  <Env2, In2, Out2>(
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => <Env, In, Out>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In & In2, Out2>,
  <Env, In, Out, Env2, In2, Out2>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>
  ) => Schedule.Schedule<Env | Env2, In & In2, Out2>
>(2, () => (self, that) => pipe(intersect(self, that), map((out) => out[1])))

/** @internal */
export const zipWith = Debug.untracedDual<
  <Env2, In2, Out2, Out, Out3>(
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (out: Out, out2: Out2) => Out3
  ) => <Env, In>(self: Schedule.Schedule<Env, In, Out>) => Schedule.Schedule<Env | Env2, In & In2, Out3>,
  <Env, In, Out, Env2, In2, Out2, Out3>(
    self: Schedule.Schedule<Env, In, Out>,
    that: Schedule.Schedule<Env2, In2, Out2>,
    f: (out: Out, out2: Out2) => Out3
  ) => Schedule.Schedule<Env | Env2, In & In2, Out3>
>(3, (restore) => (self, that, f) => pipe(intersect(self, that), map(([out, out2]) => restore(f)(out, out2))))

// -----------------------------------------------------------------------------
// Seconds
// -----------------------------------------------------------------------------

/** @internal */
export const beginningOfSecond = (now: number): number => {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    0
  ).getTime()
}

/** @internal */
export const endOfSecond = (now: number): number => {
  const date = new Date(beginningOfSecond(now))
  return date.setSeconds(date.getSeconds() + 1)
}

/** @internal */
export const nextSecond = (now: number, second: number, initial: boolean): number => {
  const date = new Date(now)
  if (date.getSeconds() === second && initial) {
    return now
  }
  if (date.getSeconds() < second) {
    return date.setSeconds(second)
  }
  // Set seconds to the provided value and add one minute
  const newDate = new Date(date.setSeconds(second))
  return newDate.setTime(newDate.getTime() + 1000 * 60)
}

// -----------------------------------------------------------------------------
// Minutes
// -----------------------------------------------------------------------------

/** @internal */
export const beginningOfMinute = (now: number): number => {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    0,
    0
  ).getTime()
}

/** @internal */
export const endOfMinute = (now: number): number => {
  const date = new Date(beginningOfMinute(now))
  return date.setMinutes(date.getMinutes() + 1)
}

/** @internal */
export const nextMinute = (now: number, minute: number, initial: boolean): number => {
  const date = new Date(now)
  if (date.getMinutes() === minute && initial) {
    return now
  }
  if (date.getMinutes() < minute) {
    return date.setMinutes(minute)
  }
  // Set minutes to the provided value and add one hour
  const newDate = new Date(date.setMinutes(minute))
  return newDate.setTime(newDate.getTime() + 1000 * 60 * 60)
}

// -----------------------------------------------------------------------------
// Hours
// -----------------------------------------------------------------------------

/** @internal */
export const beginningOfHour = (now: number): number => {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    0,
    0,
    0
  ).getTime()
}

/** @internal */
export const endOfHour = (now: number): number => {
  const date = new Date(beginningOfHour(now))
  return date.setHours(date.getHours() + 1)
}

/** @internal */
export const nextHour = (now: number, hour: number, initial: boolean): number => {
  const date = new Date(now)
  if (date.getHours() === hour && initial) {
    return now
  }
  if (date.getHours() < hour) {
    return date.setHours(hour)
  }
  // Set hours to the provided value and add one day
  const newDate = new Date(date.setHours(hour))
  return newDate.setTime(newDate.getTime() + 1000 * 60 * 60 * 24)
}

// -----------------------------------------------------------------------------
// Days
// -----------------------------------------------------------------------------

/** @internal */
export const beginningOfDay = (now: number): number => {
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  ).getTime()
}

/** @internal */
export const endOfDay = (now: number): number => {
  const date = new Date(beginningOfDay(now))
  return date.setDate(date.getDate() + 1)
}

/** @internal */
export const nextDay = (now: number, dayOfWeek: number, initial: boolean): number => {
  const date = new Date(now)
  if (date.getDay() === dayOfWeek && initial) {
    return now
  }
  const nextDayOfWeek = (7 + dayOfWeek - date.getDay()) % 7
  return date.setDate(date.getDate() + (nextDayOfWeek === 0 ? 7 : nextDayOfWeek))
}

/** @internal */
export const nextDayOfMonth = (now: number, day: number, initial: boolean): number => {
  const date = new Date(now)
  if (date.getDate() === day && initial) {
    return now
  }
  if (date.getDate() < day) {
    return date.setDate(day)
  }
  return findNextMonth(now, day, 1)
}

/** @internal */
export const findNextMonth = (now: number, day: number, months: number): number => {
  const d = new Date(now)
  const tmp1 = new Date(d.setDate(day))
  const tmp2 = new Date(tmp1.setMonth(tmp1.getMonth() + months))
  if (tmp2.getDate() === day) {
    const d2 = new Date(now)
    const tmp3 = new Date(d2.setDate(day))
    return tmp3.setMonth(tmp3.getMonth() + months)
  }
  return findNextMonth(now, day, months + 1)
}

// circular with Effect

/** @internal */
export const repeat_Effect = Debug.dualWithTrace<
  <R1, A extends A0, A0, B>(
    schedule: Schedule.Schedule<R1, A, B>
  ) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1, E, B>,
  <R, E, A extends A0, A0, R1, B>(
    self: Effect.Effect<R, E, A>,
    schedule: Schedule.Schedule<R1, A0, B>
  ) => Effect.Effect<R | R1, E, B>
>(2, (trace) => (self, schedule) => repeatOrElse_Effect(self, schedule, (e, _) => core.fail(e)).traced(trace))

/** @internal */
export const repeatOrElse_Effect = Debug.dualWithTrace<
  <R2, A extends A0, A0, B, E, R3, E2>(
    schedule: Schedule.Schedule<R2, A, B>,
    orElse: (error: E, option: Option.Option<B>) => Effect.Effect<R3, E2, B>
  ) => <R>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R2 | R3, E2, B>,
  <R, E, A extends A0, A0, R2, B, R3, E2>(
    self: Effect.Effect<R, E, A>,
    schedule: Schedule.Schedule<R2, A0, B>,
    orElse: (error: E, option: Option.Option<B>) => Effect.Effect<R3, E2, B>
  ) => Effect.Effect<R | R2 | R3, E2, B>
>(
  3,
  (trace, restore) =>
    (self, schedule, orElse) =>
      core.map(
        repeatOrElseEither_Effect(self, schedule, restore(orElse)),
        Either.merge
      ).traced(trace)
)

/** @internal */
export const repeatOrElseEither_Effect = Debug.dualWithTrace<
  <R2, A extends A0, A0, B, E, R3, E2, C>(
    schedule: Schedule.Schedule<R2, A0, B>,
    orElse: (error: E, option: Option.Option<B>) => Effect.Effect<R3, E2, C>
  ) => <R>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R2 | R3, E2, Either.Either<C, B>>,
  <R, E, A extends A0, A0, R2, B, R3, E2, C>(
    self: Effect.Effect<R, E, A>,
    schedule: Schedule.Schedule<R2, A0, B>,
    orElse: (error: E, option: Option.Option<B>) => Effect.Effect<R3, E2, C>
  ) => Effect.Effect<R | R2 | R3, E2, Either.Either<C, B>>
>(3, (trace, restore) =>
  (self, schedule, orElse) =>
    core.flatMap(driver(schedule), (driver) =>
      core.matchEffect(
        self,
        (error) => pipe(restore(orElse)(error, Option.none()), core.map(Either.left)),
        (value) => repeatOrElseEitherEffectLoop(self, driver, restore(orElse), value)
      )).traced(trace))

/** @internal */
const repeatOrElseEitherEffectLoop = <R, E, A extends A0, A0, R1, B, R2, E2, C>(
  self: Effect.Effect<R, E, A>,
  driver: Schedule.ScheduleDriver<R1, A0, B>,
  orElse: (error: E, option: Option.Option<B>) => Effect.Effect<R2, E2, C>,
  value: A
): Effect.Effect<R | R1 | R2, E2, Either.Either<C, B>> => {
  return pipe(
    driver.next(value),
    core.matchEffect(
      () => pipe(core.orDie(driver.last()), core.map(Either.right)),
      (b) =>
        pipe(
          self,
          core.matchEffect(
            (error) => pipe(orElse(error, Option.some(b)), core.map(Either.left)),
            (value) => repeatOrElseEitherEffectLoop(self, driver, orElse, value)
          )
        )
    )
  )
}

/** @internal */
export const repeatUntil_Effect = Debug.dualWithTrace<
  <A>(f: Predicate<A>) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, f: Predicate<A>) => Effect.Effect<R, E, A>
>(2, (trace, restore) =>
  (self, f) =>
    repeatUntilEffect_Effect(
      self,
      (a) => core.sync(() => restore(f)(a))
    ).traced(trace))

/** @internal */
export const repeatUntilEffect_Effect: {
  <A, R2>(
    f: (a: A) => Effect.Effect<R2, never, boolean>
  ): <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R2, E, A>
  <R, E, A, R2>(
    self: Effect.Effect<R, E, A>,
    f: (a: A) => Effect.Effect<R2, never, boolean>
  ): Effect.Effect<R | R2, E, A>
} = Debug.dualWithTrace<
  <A, R2>(
    f: (a: A) => Effect.Effect<R2, never, boolean>
  ) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R2, E, A>,
  <R, E, A, R2>(
    self: Effect.Effect<R, E, A>,
    f: (a: A) => Effect.Effect<R2, never, boolean>
  ) => Effect.Effect<R | R2, E, A>
>(2, (trace, restore) =>
  (self, f) =>
    core.flatMap(self, (a) =>
      core.flatMap(f(a), (result) =>
        result ?
          core.succeed(a) :
          core.flatMap(
            core.yieldNow(),
            () => repeatUntilEffect_Effect(self, restore(f))
          ))).traced(trace))

/** @internal */
export const repeatUntilEquals_Effect = Debug.dualWithTrace<
  <A>(value: A) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, value: A) => Effect.Effect<R, E, A>
>(2, (trace) => (self, value) => repeatUntil_Effect(self, (a) => Equal.equals(a, value)).traced(trace))

/** @internal */
export const repeatWhile_Effect = Debug.dualWithTrace<
  <A>(f: Predicate<A>) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, f: Predicate<A>) => Effect.Effect<R, E, A>
>(2, (trace, restore) =>
  (self, f) =>
    repeatWhileEffect_Effect(
      self,
      (a) => core.sync(() => restore(f)(a))
    ).traced(trace))

/** @internal */
export const repeatWhileEffect_Effect = Debug.dualWithTrace<
  <R1, A>(
    f: (a: A) => Effect.Effect<R1, never, boolean>
  ) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1, E, A>,
  <R, E, R1, A>(
    self: Effect.Effect<R, E, A>,
    f: (a: A) => Effect.Effect<R1, never, boolean>
  ) => Effect.Effect<R | R1, E, A>
>(2, (trace, restore) => (self, f) => repeatUntilEffect_Effect(self, (a) => effect.negate(restore(f)(a))).traced(trace))

/** @internal */
export const repeatWhileEquals_Effect = Debug.dualWithTrace<
  <A>(value: A) => <R, E>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, value: A) => Effect.Effect<R, E, A>
>(2, (trace) => (self, value) => repeatWhile_Effect(self, (a) => Equal.equals(a, value)).traced(trace))

/** @internal */
export const retry_Effect = Debug.dualWithTrace<
  <R1, E extends E0, E0, B>(
    policy: Schedule.Schedule<R1, E0, B>
  ) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1, E, A>,
  <R, E extends E0, E0, A, R1, B>(
    self: Effect.Effect<R, E, A>,
    policy: Schedule.Schedule<R1, E0, B>
  ) => Effect.Effect<R | R1, E, A>
>(2, (trace) => (self, policy) => retryOrElse_Effect(self, policy, (e, _) => core.fail(e)).traced(trace))

/** @internal */
export const retryN_Effect = Debug.dualWithTrace<
  (n: number) => <R, E, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, n: number) => Effect.Effect<R, E, A>
>(2, (trace) => (self, n) => retryN_EffectLoop(self, n).traced(trace))

/** @internal */
const retryN_EffectLoop = <R, E, A>(
  self: Effect.Effect<R, E, A>,
  n: number
): Effect.Effect<R, E, A> => {
  return core.catchAll(self, (e) =>
    n < 0 ?
      core.fail(e) :
      core.flatMap(core.yieldNow(), () => retryN_EffectLoop(self, n - 1)))
}

/** @internal */
export const retryOrElse_Effect = Debug.dualWithTrace<
  <R1, E extends E3, A1, R2, E2, A2, E3>(
    policy: Schedule.Schedule<R1, E3, A1>,
    orElse: (e: E, out: A1) => Effect.Effect<R2, E2, A2>
  ) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1 | R2, E | E2, A | A2>,
  <R, E extends E3, A, R1, A1, R2, E2, A2, E3>(
    self: Effect.Effect<R, E, A>,
    policy: Schedule.Schedule<R1, E3, A1>,
    orElse: (e: E, out: A1) => Effect.Effect<R2, E2, A2>
  ) => Effect.Effect<R | R1 | R2, E | E2, A | A2>
>(3, (trace, restore) =>
  (self, policy, orElse) =>
    core.map(
      retryOrElseEither_Effect(self, policy, restore(orElse)),
      Either.merge
    ).traced(trace))

/** @internal */
export const retryOrElseEither_Effect = Debug.dualWithTrace<
  <R1, E extends E3, A1, R2, E2, A2, E3>(
    policy: Schedule.Schedule<R1, E3, A1>,
    orElse: (e: E, out: A1) => Effect.Effect<R2, E2, A2>
  ) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1 | R2, E | E2, Either.Either<A2, A>>,
  <R, A, E extends E3, R1, A1, R2, E2, A2, E3>(
    self: Effect.Effect<R, E, A>,
    policy: Schedule.Schedule<R1, E3, A1>,
    orElse: (e: E, out: A1) => Effect.Effect<R2, E2, A2>
  ) => Effect.Effect<R | R1 | R2, E | E2, Either.Either<A2, A>>
>(3, (trace, restore) =>
  (self, policy, orElse) =>
    core.flatMap(
      driver(policy),
      (driver) => retryOrElseEither_EffectLoop(self, driver, restore(orElse))
    ).traced(trace))

/** @internal */
const retryOrElseEither_EffectLoop = <R, E, A, R1, A1, R2, E2, A2>(
  self: Effect.Effect<R, E, A>,
  driver: Schedule.ScheduleDriver<R1, E, A1>,
  orElse: (e: E, out: A1) => Effect.Effect<R2, E2, A2>
): Effect.Effect<R | R1 | R2, E | E2, Either.Either<A2, A>> => {
  return pipe(
    self,
    core.map(Either.right),
    core.catchAll((e) =>
      pipe(
        driver.next(e),
        core.matchEffect(
          () =>
            pipe(
              driver.last(),
              core.orDie,
              core.flatMap((out) => pipe(orElse(e, out), core.map(Either.left)))
            ),
          () => retryOrElseEither_EffectLoop(self, driver, orElse)
        )
      )
    )
  )
}

/** @internal */
export const retryUntil_Effect = Debug.dualWithTrace<
  <E>(f: Predicate<E>) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, f: Predicate<E>) => Effect.Effect<R, E, A>
>(2, (trace, restore) =>
  (self, f) =>
    retryUntilEffect_Effect(
      self,
      (e) => core.sync(() => restore(f)(e))
    ).traced(trace))

/** @internal */
export const retryUntilEffect_Effect: {
  <R1, E>(
    f: (e: E) => Effect.Effect<R1, never, boolean>
  ): <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1, E, A>
  <R, E, A, R1>(
    self: Effect.Effect<R, E, A>,
    f: (e: E) => Effect.Effect<R1, never, boolean>
  ): Effect.Effect<R | R1, E, A>
} = Debug.dualWithTrace<
  <R1, E>(
    f: (e: E) => Effect.Effect<R1, never, boolean>
  ) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1, E, A>,
  <R, E, A, R1>(
    self: Effect.Effect<R, E, A>,
    f: (e: E) => Effect.Effect<R1, never, boolean>
  ) => Effect.Effect<R | R1, E, A>
>(2, (trace, restore) =>
  (self, f) =>
    core.catchAll(self, (e) =>
      core.flatMap(restore(f)(e), (b) =>
        b ?
          core.fail(e) :
          core.flatMap(
            core.yieldNow(),
            () => retryUntilEffect_Effect(self, restore(f))
          ))).traced(trace))

/** @internal */
export const retryUntilEquals_Effect = Debug.dualWithTrace<
  <E>(e: E) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, e: E) => Effect.Effect<R, E, A>
>(2, (trace) => (self, e) => retryUntil_Effect(self, (_) => Equal.equals(_, e)).traced(trace))

/** @internal */
export const retryWhile_Effect = Debug.dualWithTrace<
  <E>(f: Predicate<E>) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, f: Predicate<E>) => Effect.Effect<R, E, A>
>(
  2,
  (trace, restore) => (self, f) => retryWhileEffect_Effect(self, (e) => core.sync(() => restore(f)(e))).traced(trace)
)

/** @internal */
export const retryWhileEffect_Effect = Debug.dualWithTrace<
  <R1, E>(
    f: (e: E) => Effect.Effect<R1, never, boolean>
  ) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R1, E, A>,
  <R, E, A, R1>(
    self: Effect.Effect<R, E, A>,
    f: (e: E) => Effect.Effect<R1, never, boolean>
  ) => Effect.Effect<R | R1, E, A>
>(2, (trace, restore) => (self, f) => retryUntilEffect_Effect(self, (e) => effect.negate(restore(f)(e))).traced(trace))

/** @internal */
export const retryWhileEquals_Effect = Debug.dualWithTrace<
  <E>(e: E) => <R, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R, E, A>,
  <R, E, A>(self: Effect.Effect<R, E, A>, e: E) => Effect.Effect<R, E, A>
>(2, (trace) => (self, e) => retryWhile_Effect(self, (err) => Equal.equals(e, err)).traced(trace))

/** @internal */
export const schedule_Effect = Debug.dualWithTrace<
  <R2, Out>(
    schedule: Schedule.Schedule<R2, unknown, Out>
  ) => <R, E, A>(self: Effect.Effect<R, E, A>) => Effect.Effect<R | R2, E, Out>,
  <R, E, A, R2, Out>(
    self: Effect.Effect<R, E, A>,
    schedule: Schedule.Schedule<R2, unknown, Out>
  ) => Effect.Effect<R | R2, E, Out>
>(2, (trace) =>
  <R, E, A, R2, Out>(
    self: Effect.Effect<R, E, A>,
    schedule: Schedule.Schedule<R2, unknown, Out>
  ) => scheduleFrom_Effect(self, void 0, schedule).traced(trace))

/** @internal */
export const scheduleFrom_Effect = Debug.dualWithTrace<
  <R2, In, Out>(
    initial: In,
    schedule: Schedule.Schedule<R2, In, Out>
  ) => <R, E>(self: Effect.Effect<R, E, In>) => Effect.Effect<R | R2, E, Out>,
  <R, E, In, R2, Out>(
    self: Effect.Effect<R, E, In>,
    initial: In,
    schedule: Schedule.Schedule<R2, In, Out>
  ) => Effect.Effect<R | R2, E, Out>
>(3, (trace) =>
  (self, initial, schedule) =>
    core.flatMap(
      driver(schedule),
      (driver) => scheduleFrom_EffectLoop(self, initial, driver)
    ).traced(trace))

/** @internal */
const scheduleFrom_EffectLoop = <R, E, In, R2, Out>(
  self: Effect.Effect<R, E, In>,
  initial: In,
  driver: Schedule.ScheduleDriver<R2, In, Out>
): Effect.Effect<R | R2, E, Out> =>
  pipe(
    driver.next(initial),
    core.matchEffect(
      () => core.orDie(driver.last()),
      () => pipe(self, core.flatMap((a) => scheduleFrom_EffectLoop(self, a, driver)))
    )
  )
