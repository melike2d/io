/**
 * @since 1.0.0
 */
import type * as Exit from "@effect/io/Exit"
import type * as FiberId from "@effect/io/Fiber/Id"
import type * as FiberRef from "@effect/io/FiberRef"
import type { TODO } from "@effect/io/internal/todo"

/**
 * @since 1.0.0
 */
export type Runtime<E, A> = {
  id: FiberId.FiberId
  addObserver(observer: (exit: Exit.Exit<E, A>) => void): void
  deleteFiberRef<X>(ref: FiberRef.FiberRef<X>): void
  getFiberRef<X>(ref: FiberRef.FiberRef<X>): X
  setFiberRef<X>(ref: FiberRef.FiberRef<X>, x: X): X
  todo: TODO<[E, A]>
}
