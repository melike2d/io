import * as Context from "@effect/data/Context"
import * as Debug from "@effect/data/Debug"
import { pipe } from "@effect/data/Function"
import { globalValue } from "@effect/data/Global"
import type * as Effect from "@effect/io/Effect"
import * as core from "@effect/io/internal_effect_untraced/core"
import * as effect from "@effect/io/internal_effect_untraced/effect"
import * as fiberRuntime from "@effect/io/internal_effect_untraced/fiberRuntime"
import * as _layer from "@effect/io/internal_effect_untraced/layer"
import * as _schedule from "@effect/io/internal_effect_untraced/schedule"
import * as scopedRef from "@effect/io/internal_effect_untraced/scopedRef"
import type * as Layer from "@effect/io/Layer"
import type * as Reloadable from "@effect/io/Reloadable"
import type * as Schedule from "@effect/io/Schedule"

/** @internal */
const ReloadableSymbolKey = "@effect/io/Reloadable"

/** @internal */
export const ReloadableTypeId: Reloadable.ReloadableTypeId = Symbol.for(
  ReloadableSymbolKey
) as Reloadable.ReloadableTypeId

/** @internal */
const reloadableVariance = {
  _A: (_: never) => _
}

/** @internal */
export const auto = <Out extends Context.Tag<any, any>, In, E, R>(
  tag: Out,
  layer: Layer.Layer<In, E, Context.Tag.Identifier<Out>>,
  policy: Schedule.Schedule<R, unknown, unknown>
): Layer.Layer<
  R | In,
  E,
  Reloadable.Reloadable<Context.Tag.Identifier<Out>>
> =>
  _layer.scoped(
    reloadableTag(tag),
    pipe(
      _layer.build(manual(tag, layer)),
      core.map(Context.unsafeGet(reloadableTag(tag))),
      core.tap((reloadable) =>
        fiberRuntime.acquireRelease(
          pipe(
            reloadable.reload(),
            effect.ignoreLogged,
            _schedule.schedule_Effect(policy),
            fiberRuntime.forkDaemon
          ),
          core.interruptFiber
        )
      )
    )
  )

/** @internal */
export const autoFromConfig = <Out extends Context.Tag<any, any>, In, E, R>(
  tag: Out,
  layer: Layer.Layer<In, E, Context.Tag.Identifier<Out>>,
  scheduleFromConfig: (context: Context.Context<In>) => Schedule.Schedule<R, unknown, unknown>
): Layer.Layer<
  R | In,
  E,
  Reloadable.Reloadable<Context.Tag.Identifier<Out>>
> =>
  _layer.scoped(
    reloadableTag(tag),
    pipe(
      core.context<In>(),
      core.flatMap((env) =>
        pipe(
          _layer.build(auto(tag, layer, scheduleFromConfig(env))),
          core.map(Context.unsafeGet(reloadableTag(tag)))
        )
      )
    )
  )

/** @internal */
export const get = Debug.methodWithTrace((trace) =>
  <T extends Context.Tag<any, any>>(
    tag: T
  ): Effect.Effect<Reloadable.Reloadable<Context.Tag.Identifier<T>>, never, Context.Tag.Service<T>> =>
    core.flatMap(
      reloadableTag(tag),
      (reloadable) => scopedRef.get(reloadable.scopedRef)
    ).traced(trace)
)

/** @internal */
export const manual = <Out extends Context.Tag<any, any>, In, E>(
  tag: Out,
  layer: Layer.Layer<In, E, Context.Tag.Identifier<Out>>
): Layer.Layer<In, E, Reloadable.Reloadable<Context.Tag.Identifier<Out>>> => {
  return _layer.scoped(
    reloadableTag(tag),
    pipe(
      core.context<In>(),
      core.flatMap((env) =>
        pipe(
          scopedRef.fromAcquire(pipe(_layer.build(layer), core.map(Context.unsafeGet(tag)))),
          core.map((ref) => ({
            [ReloadableTypeId]: reloadableVariance,
            scopedRef: ref,
            reload: () =>
              Debug.bodyWithTrace((trace) =>
                pipe(
                  scopedRef.set(ref, pipe(_layer.build(layer), core.map(Context.unsafeGet(tag)))),
                  core.provideContext(env)
                ).traced(trace)
              )
          }))
        )
      )
    )
  )
}

/** @internal */
const tagMap = globalValue(
  Symbol.for("@effect/io/Reloadable/tagMap"),
  () => new WeakMap<Context.Tag<any, any>, Context.Tag<any, any>>([])
)

/** @internal */
export const reloadableTag = <T extends Context.Tag<any, any>>(
  tag: T
): Context.Tag<Reloadable.Reloadable<Context.Tag.Identifier<T>>, Reloadable.Reloadable<Context.Tag.Service<T>>> => {
  if (tagMap.has(tag)) {
    return tagMap.get(tag)!
  }
  const newTag = Context.Tag<
    Reloadable.Reloadable<Context.Tag.Identifier<T>>,
    Reloadable.Reloadable<Context.Tag.Service<T>>
  >()
  tagMap.set(tag, newTag)
  return newTag
}

/** @internal */
export const reload = Debug.methodWithTrace((trace) =>
  <T extends Context.Tag<any, any>>(
    tag: T
  ): Effect.Effect<Reloadable.Reloadable<Context.Tag.Identifier<T>>, unknown, void> =>
    core.flatMap(
      reloadableTag(tag),
      (reloadable) => reloadable.reload()
    ).traced(trace)
)

/** @internal */
export const reloadFork = Debug.methodWithTrace((trace) =>
  <T extends Context.Tag<any, any>>(
    tag: T
  ): Effect.Effect<Reloadable.Reloadable<Context.Tag.Identifier<T>>, unknown, void> =>
    core.flatMap(reloadableTag(tag), (reloadable) =>
      pipe(
        reloadable.reload(),
        effect.ignoreLogged,
        fiberRuntime.forkDaemon,
        core.asUnit
      ).traced(trace))
)
