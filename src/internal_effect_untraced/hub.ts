import * as Chunk from "@effect/data/Chunk"
import * as Debug from "@effect/data/Debug"
import { pipe } from "@effect/data/Function"
import * as MutableQueue from "@effect/data/MutableQueue"
import * as MutableRef from "@effect/data/MutableRef"
import type * as Deferred from "@effect/io/Deferred"
import type * as Effect from "@effect/io/Effect"
import type * as Hub from "@effect/io/Hub"
import * as cause from "@effect/io/internal_effect_untraced/cause"
import * as core from "@effect/io/internal_effect_untraced/core"
import * as fiberRuntime from "@effect/io/internal_effect_untraced/fiberRuntime"
import * as queue from "@effect/io/internal_effect_untraced/queue"
import type * as Queue from "@effect/io/Queue"
import type * as Scope from "@effect/io/Scope"

/** @internal */
export interface AtomicHub<A> {
  readonly capacity: number
  isEmpty(): boolean
  isFull(): boolean
  size(): number
  publish(value: A): boolean
  publishAll(elements: Iterable<A>): Chunk.Chunk<A>
  slide(): void
  subscribe(): Subscription<A>
}

/** @internal */
interface Subscription<A> {
  isEmpty(): boolean
  size(): number
  poll<D>(default_: D): A | D
  pollUpTo(n: number): Chunk.Chunk<A>
  unsubscribe(): void
}

/** @internal */
type Subscribers<A> = Map<
  Subscription<A>,
  Set<MutableQueue.MutableQueue<Deferred.Deferred<never, A>>>
>

const addSubscribers = <A>(
  subscription: Subscription<A>,
  pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
) =>
  (subscribers: Subscribers<A>) => {
    if (!subscribers.has(subscription)) {
      subscribers.set(subscription, new Set())
    }
    const set = subscribers.get(subscription)!
    set.add(pollers)
  }

const removeSubscribers = <A>(
  subscription: Subscription<A>,
  pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
) =>
  (subscribers: Subscribers<A>) => {
    if (!subscribers.has(subscription)) {
      return
    }
    const set = subscribers.get(subscription)!
    set.delete(pollers)
    if (set.size === 0) {
      subscribers.delete(subscription)
    }
  }

/** @internal */
export const bounded = Debug.methodWithTrace((trace) =>
  <A>(requestedCapacity: number): Effect.Effect<never, never, Hub.Hub<A>> =>
    pipe(
      core.sync(() => makeBoundedHub<A>(requestedCapacity)),
      core.flatMap((atomicHub) => makeHub(atomicHub, new BackPressureStrategy()))
    ).traced(trace)
)

/** @internal */
export const dropping = Debug.methodWithTrace((trace) =>
  <A>(requestedCapacity: number): Effect.Effect<never, never, Hub.Hub<A>> =>
    pipe(
      core.sync(() => makeBoundedHub<A>(requestedCapacity)),
      core.flatMap((atomicHub) => makeHub(atomicHub, new DroppingStrategy()))
    ).traced(trace)
)

/** @internal */
export const sliding = Debug.methodWithTrace((trace) =>
  <A>(requestedCapacity: number): Effect.Effect<never, never, Hub.Hub<A>> =>
    pipe(
      core.sync(() => makeBoundedHub<A>(requestedCapacity)),
      core.flatMap((atomicHub) => makeHub(atomicHub, new SlidingStrategy()))
    ).traced(trace)
)

/** @internal */
export const unbounded = Debug.methodWithTrace((trace) =>
  <A>(): Effect.Effect<never, never, Hub.Hub<A>> =>
    pipe(
      core.sync(() => makeUnboundedHub<A>()),
      core.flatMap((atomicHub) => makeHub(atomicHub, new DroppingStrategy()))
    ).traced(trace)
)

/** @internal */
export const capacity = <A>(self: Hub.Hub<A>): number => {
  return self.capacity()
}

/** @internal */
export const size = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<never, never, number> => self.size().traced(trace)
)

/** @internal */
export const isFull = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<never, never, boolean> => self.isFull().traced(trace)
)

/** @internal */
export const isEmpty = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<never, never, boolean> => self.isEmpty().traced(trace)
)

/** @internal */
export const shutdown = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<never, never, void> => self.shutdown().traced(trace)
)

/** @internal */
export const isShutdown = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<never, never, boolean> => self.isShutdown().traced(trace)
)

/** @internal */
export const awaitShutdown = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<never, never, void> => self.awaitShutdown().traced(trace)
)

/** @internal */
export const publish = Debug.dualWithTrace<
  <A>(value: A) => (self: Hub.Hub<A>) => Effect.Effect<never, never, boolean>,
  <A>(self: Hub.Hub<A>, value: A) => Effect.Effect<never, never, boolean>
>(2, (trace) => (self, value) => self.publish(value).traced(trace))

/** @internal */
export const publishAll = Debug.dualWithTrace<
  <A>(elements: Iterable<A>) => (self: Hub.Hub<A>) => Effect.Effect<never, never, boolean>,
  <A>(self: Hub.Hub<A>, elements: Iterable<A>) => Effect.Effect<never, never, boolean>
>(2, (trace) => (self, elements) => self.publishAll(elements).traced(trace))

/** @internal */
export const subscribe = Debug.methodWithTrace((trace) =>
  <A>(self: Hub.Hub<A>): Effect.Effect<Scope.Scope, never, Queue.Dequeue<A>> => self.subscribe().traced(trace)
)

/** @internal */
const makeBoundedHub = <A>(requestedCapacity: number): AtomicHub<A> => {
  ensureCapacity(requestedCapacity)
  if (requestedCapacity === 1) {
    return new BoundedHubSingle()
  } else if (nextPow2(requestedCapacity) === requestedCapacity) {
    return new BoundedHubPow2(requestedCapacity)
  } else {
    return new BoundedHubArb(requestedCapacity)
  }
}

/** @internal */
const makeUnboundedHub = <A>(): AtomicHub<A> => {
  return new UnboundedHub()
}

/** @internal */
const makeSubscription = Debug.methodWithTrace((trace) =>
  <A>(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    strategy: HubStrategy<A>
  ): Effect.Effect<never, never, Queue.Dequeue<A>> =>
    core.map(core.deferredMake<never, void>(), (deferred) =>
      unsafeMakeSubscription(
        hub,
        subscribers,
        hub.subscribe(),
        MutableQueue.unbounded<Deferred.Deferred<never, A>>(),
        deferred,
        MutableRef.make(false),
        strategy
      )).traced(trace)
)

/** @internal */
export const unsafeMakeSubscription = <A>(
  hub: AtomicHub<A>,
  subscribers: Subscribers<A>,
  subscription: Subscription<A>,
  pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>,
  shutdownHook: Deferred.Deferred<never, void>,
  shutdownFlag: MutableRef.MutableRef<boolean>,
  strategy: HubStrategy<A>
): Queue.Dequeue<A> => {
  return new SubscriptionImpl(
    hub,
    subscribers,
    subscription,
    pollers,
    shutdownHook,
    shutdownFlag,
    strategy
  )
}

/** @internal */
class BoundedHubArb<A> implements AtomicHub<A> {
  array: Array<A>
  publisherIndex = 0
  subscribers: Array<number>
  subscriberCount = 0
  subscribersIndex = 0

  readonly capacity: number

  constructor(requestedCapacity: number) {
    this.array = Array.from({ length: requestedCapacity })
    this.subscribers = Array.from({ length: requestedCapacity })
    this.capacity = requestedCapacity
  }

  isEmpty(): boolean {
    return this.publisherIndex === this.subscribersIndex
  }

  isFull(): boolean {
    return this.publisherIndex === this.subscribersIndex + this.capacity
  }

  size(): number {
    return this.publisherIndex - this.subscribersIndex
  }

  publish(value: A): boolean {
    if (this.isFull()) {
      return false
    }
    if (this.subscriberCount !== 0) {
      const index = this.publisherIndex % this.capacity
      this.array[index] = value
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
    }
    return true
  }

  publishAll(elements: Iterable<A>): Chunk.Chunk<A> {
    const chunk = Chunk.fromIterable(elements)
    const n = chunk.length
    const size = this.publisherIndex - this.subscribersIndex
    const available = this.capacity - size
    const forHub = Math.min(n, available)
    if (forHub === 0) {
      return chunk
    }
    let iteratorIndex = 0
    const publishAllIndex = this.publisherIndex + forHub
    while (this.publisherIndex !== publishAllIndex) {
      const a = pipe(chunk, Chunk.unsafeGet(iteratorIndex++))
      const index = this.publisherIndex % this.capacity
      this.array[index] = a
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
    }
    return pipe(chunk, Chunk.drop(iteratorIndex - 1))
  }

  slide(): void {
    if (this.subscribersIndex !== this.publisherIndex) {
      const index = this.subscribersIndex % this.capacity
      this.array[index] = null as unknown as A
      this.subscribers[index] = 0
      this.subscribersIndex += 1
    }
  }

  subscribe(): Subscription<A> {
    this.subscriberCount += 1
    return new BoundedHubArbSubscription(this, this.publisherIndex, false)
  }
}

class BoundedHubArbSubscription<A> implements Subscription<A> {
  constructor(
    private self: BoundedHubArb<A>,
    private subscriberIndex: number,
    private unsubscribed: boolean
  ) {
  }

  isEmpty(): boolean {
    return (
      this.unsubscribed ||
      this.self.publisherIndex === this.subscriberIndex ||
      this.self.publisherIndex === this.self.subscribersIndex
    )
  }

  size() {
    if (this.unsubscribed) {
      return 0
    }
    return this.self.publisherIndex - Math.max(this.subscriberIndex, this.self.subscribersIndex)
  }

  poll<D>(default_: D): A | D {
    if (this.unsubscribed) {
      return default_
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    if (this.subscriberIndex !== this.self.publisherIndex) {
      const index = this.subscriberIndex % this.self.capacity
      const elem = this.self.array[index]!
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = null as unknown as A
        this.self.subscribersIndex += 1
      }
      this.subscriberIndex += 1
      return elem
    }
    return default_
  }

  pollUpTo(n: number): Chunk.Chunk<A> {
    if (this.unsubscribed) {
      return Chunk.empty()
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    const size = this.self.publisherIndex - this.subscriberIndex
    const toPoll = Math.min(n, size)
    if (toPoll <= 0) {
      return Chunk.empty()
    }
    const builder: Array<A> = []
    const pollUpToIndex = this.subscriberIndex + toPoll
    while (this.subscriberIndex !== pollUpToIndex) {
      const index = this.subscriberIndex % this.self.capacity
      const a = this.self.array[index] as A
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = null as unknown as A
        this.self.subscribersIndex += 1
      }
      builder.push(a)
      this.subscriberIndex += 1
    }

    return Chunk.fromIterable(builder)
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.subscriberCount -= 1
      this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
      while (this.subscriberIndex !== this.self.publisherIndex) {
        const index = this.subscriberIndex % this.self.capacity
        this.self.subscribers[index] -= 1
        if (this.self.subscribers[index] === 0) {
          this.self.array[index] = null as unknown as A
          this.self.subscribersIndex += 1
        }
        this.subscriberIndex += 1
      }
    }
  }
}

/** @internal */
class BoundedHubPow2<A> implements AtomicHub<A> {
  array: Array<A>
  mask: number
  publisherIndex = 0
  subscribers: Array<number>
  subscriberCount = 0
  subscribersIndex = 0

  readonly capacity: number

  constructor(requestedCapacity: number) {
    this.array = Array.from({ length: requestedCapacity })
    this.mask = requestedCapacity - 1
    this.subscribers = Array.from({ length: requestedCapacity })
    this.capacity = requestedCapacity
  }

  isEmpty(): boolean {
    return this.publisherIndex === this.subscribersIndex
  }

  isFull(): boolean {
    return this.publisherIndex === this.subscribersIndex + this.capacity
  }

  size(): number {
    return this.publisherIndex - this.subscribersIndex
  }

  publish(value: A): boolean {
    if (this.isFull()) {
      return false
    }
    if (this.subscriberCount !== 0) {
      const index = this.publisherIndex & this.mask
      this.array[index] = value
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
    }
    return true
  }

  publishAll(elements: Iterable<A>): Chunk.Chunk<A> {
    const chunk = Chunk.fromIterable(elements)
    const n = chunk.length
    const size = this.publisherIndex - this.subscribersIndex
    const available = this.capacity - size
    const forHub = Math.min(n, available)
    if (forHub === 0) {
      return chunk
    }
    let iteratorIndex = 0
    const publishAllIndex = this.publisherIndex + forHub
    while (this.publisherIndex !== publishAllIndex) {
      const elem = pipe(chunk, Chunk.unsafeGet(iteratorIndex++))
      const index = this.publisherIndex & this.mask
      this.array[index] = elem
      this.subscribers[index] = this.subscriberCount
      this.publisherIndex += 1
    }
    return pipe(chunk, Chunk.drop(iteratorIndex - 1))
  }

  slide(): void {
    if (this.subscribersIndex !== this.publisherIndex) {
      const index = this.subscribersIndex & this.mask
      this.array[index] = null as unknown as A
      this.subscribers[index] = 0
      this.subscribersIndex += 1
    }
  }

  subscribe(): Subscription<A> {
    this.subscriberCount += 1
    return new BoundedHubPow2Subscription(this, this.publisherIndex, false)
  }
}

/** @internal */
class BoundedHubPow2Subscription<A> implements Subscription<A> {
  constructor(
    private self: BoundedHubPow2<A>,
    private subscriberIndex: number,
    private unsubscribed: boolean
  ) {
  }

  isEmpty(): boolean {
    return (
      this.unsubscribed ||
      this.self.publisherIndex === this.subscriberIndex ||
      this.self.publisherIndex === this.self.subscribersIndex
    )
  }

  size() {
    if (this.unsubscribed) {
      return 0
    }
    return this.self.publisherIndex - Math.max(this.subscriberIndex, this.self.subscribersIndex)
  }

  poll<D>(default_: D): A | D {
    if (this.unsubscribed) {
      return default_
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    if (this.subscriberIndex !== this.self.publisherIndex) {
      const index = this.subscriberIndex & this.self.mask
      const elem = this.self.array[index]!
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = null as unknown as A
        this.self.subscribersIndex += 1
      }
      this.subscriberIndex += 1
      return elem
    }
    return default_
  }

  pollUpTo(n: number): Chunk.Chunk<A> {
    if (this.unsubscribed) {
      return Chunk.empty()
    }
    this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
    const size = this.self.publisherIndex - this.subscriberIndex
    const toPoll = Math.min(n, size)
    if (toPoll <= 0) {
      return Chunk.empty()
    }
    const builder: Array<A> = []
    const pollUpToIndex = this.subscriberIndex + toPoll
    while (this.subscriberIndex !== pollUpToIndex) {
      const index = this.subscriberIndex & this.self.mask
      const elem = this.self.array[index] as A
      this.self.subscribers[index] -= 1
      if (this.self.subscribers[index] === 0) {
        this.self.array[index] = null as unknown as A
        this.self.subscribersIndex += 1
      }
      builder.push(elem)
      this.subscriberIndex += 1
    }
    return Chunk.fromIterable(builder)
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.subscriberCount -= 1
      this.subscriberIndex = Math.max(this.subscriberIndex, this.self.subscribersIndex)
      while (this.subscriberIndex !== this.self.publisherIndex) {
        const index = this.subscriberIndex & this.self.mask
        this.self.subscribers[index] -= 1
        if (this.self.subscribers[index] === 0) {
          this.self.array[index] = null as unknown as A
          this.self.subscribersIndex += 1
        }
        this.subscriberIndex += 1
      }
    }
  }
}

/** @internal */
class BoundedHubSingle<A> implements AtomicHub<A> {
  publisherIndex = 0
  subscriberCount = 0
  subscribers = 0
  value: A = null as unknown as A

  readonly capacity = 1

  isEmpty(): boolean {
    return this.subscribers === 0
  }

  isFull(): boolean {
    return !this.isEmpty()
  }

  size(): number {
    return this.isEmpty() ? 0 : 1
  }

  publish(value: A): boolean {
    if (this.isFull()) {
      return false
    }
    if (this.subscriberCount !== 0) {
      this.value = value
      this.subscribers = this.subscriberCount
      this.publisherIndex += 1
    }
    return true
  }

  publishAll(elements: Iterable<A>): Chunk.Chunk<A> {
    const chunk = Chunk.fromIterable(elements)
    if (Chunk.isEmpty(chunk)) {
      return chunk
    }
    if (this.publish(Chunk.unsafeHead(chunk))) {
      return pipe(chunk, Chunk.drop(1))
    } else {
      return chunk
    }
  }

  slide(): void {
    if (this.isFull()) {
      this.subscribers = 0
      this.value = null as unknown as A
    }
  }

  subscribe(): Subscription<A> {
    this.subscriberCount += 1
    return new BoundedHubSingleSubscription(this, this.publisherIndex, false)
  }
}

/** @internal */
class BoundedHubSingleSubscription<A> implements Subscription<A> {
  constructor(
    private self: BoundedHubSingle<A>,
    private subscriberIndex: number,
    private unsubscribed: boolean
  ) {
  }

  isEmpty(): boolean {
    return (
      this.unsubscribed ||
      this.self.subscribers === 0 ||
      this.subscriberIndex === this.self.publisherIndex
    )
  }

  size() {
    return this.isEmpty() ? 0 : 1
  }

  poll<D>(default_: D): A | D {
    if (this.isEmpty()) {
      return default_
    }
    const elem = this.self.value
    this.self.subscribers -= 1
    if (this.self.subscribers === 0) {
      this.self.value = null as unknown as A
    }
    this.subscriberIndex += 1
    return elem
  }

  pollUpTo(n: number): Chunk.Chunk<A> {
    if (this.isEmpty() || n < 1) {
      return Chunk.empty()
    }
    const a = this.self.value
    this.self.subscribers -= 1
    if (this.self.subscribers === 0) {
      this.self.value = null as unknown as A
    }
    this.subscriberIndex += 1
    return Chunk.of(a)
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.subscriberCount -= 1
      if (this.subscriberIndex !== this.self.publisherIndex) {
        this.self.subscribers -= 1
        if (this.self.subscribers === 0) {
          this.self.value = null as unknown as A
        }
      }
    }
  }
}

/** @internal */
class Node<A> {
  constructor(
    public value: A | null,
    public subscribers: number,
    public next: Node<A> | null
  ) {
  }
}

/** @internal */
class UnboundedHub<A> implements AtomicHub<A> {
  publisherHead = new Node<A>(null, 0, null)
  publisherIndex = 0
  publisherTail: Node<A>
  subscribersIndex = 0

  readonly capacity = Number.MAX_SAFE_INTEGER

  constructor() {
    this.publisherTail = this.publisherHead
  }

  isEmpty(): boolean {
    return this.publisherHead === this.publisherTail
  }

  isFull(): boolean {
    return false
  }

  size(): number {
    return this.publisherIndex - this.subscribersIndex
  }

  publish(value: A): boolean {
    const subscribers = this.publisherTail.subscribers
    if (subscribers !== 0) {
      this.publisherTail.next = new Node(value, subscribers, null)
      this.publisherTail = this.publisherTail.next
      this.publisherIndex += 1
    }
    return true
  }

  publishAll(elements: Iterable<A>): Chunk.Chunk<A> {
    for (const a of elements) {
      this.publish(a)
    }
    return Chunk.empty()
  }

  slide(): void {
    if (this.publisherHead !== this.publisherTail) {
      this.publisherHead = this.publisherHead.next!
      this.publisherHead.value = null
      this.subscribersIndex += 1
    }
  }

  subscribe(): Subscription<A> {
    this.publisherTail.subscribers += 1
    return new UnboundedHubSubscription(
      this,
      this.publisherTail,
      this.publisherIndex,
      false
    )
  }
}

/** @internal */
class UnboundedHubSubscription<A> implements Subscription<A> {
  constructor(
    private self: UnboundedHub<A>,
    private subscriberHead: Node<A>,
    private subscriberIndex: number,
    private unsubscribed: boolean
  ) {
  }

  isEmpty(): boolean {
    if (this.unsubscribed) {
      return true
    }
    let empty = true
    let loop = true
    while (loop) {
      if (this.subscriberHead === this.self.publisherTail) {
        loop = false
      } else {
        if (this.subscriberHead.next!.value !== null) {
          empty = false
          loop = false
        } else {
          this.subscriberHead = this.subscriberHead.next!
          this.subscriberIndex += 1
        }
      }
    }
    return empty
  }

  size() {
    if (this.unsubscribed) {
      return 0
    }
    return this.self.publisherIndex - Math.max(this.subscriberIndex, this.self.subscribersIndex)
  }

  poll<D>(default_: D): A | D {
    if (this.unsubscribed) {
      return default_
    }
    let loop = true
    let polled: A | D = default_
    while (loop) {
      if (this.subscriberHead === this.self.publisherTail) {
        loop = false
      } else {
        const elem = this.subscriberHead.next!.value
        if (elem !== null) {
          polled = elem
          this.subscriberHead.subscribers -= 1
          if (this.subscriberHead.subscribers === 0) {
            this.self.publisherHead = this.self.publisherHead.next!
            this.self.publisherHead.value = null
            this.self.subscribersIndex += 1
          }
          loop = false
        }
        this.subscriberHead = this.subscriberHead.next!
        this.subscriberIndex += 1
      }
    }
    return polled
  }

  pollUpTo(n: number): Chunk.Chunk<A> {
    const builder: Array<A> = []
    const default_ = null
    let i = 0
    while (i !== n) {
      const a = this.poll(default_ as unknown as A)
      if (a === default_) {
        i = n
      } else {
        builder.push(a)
        i += 1
      }
    }
    return Chunk.fromIterable(builder)
  }

  unsubscribe(): void {
    if (!this.unsubscribed) {
      this.unsubscribed = true
      this.self.publisherTail.subscribers -= 1
      while (this.subscriberHead !== this.self.publisherTail) {
        if (this.subscriberHead.next!.value !== null) {
          this.subscriberHead.subscribers -= 1
          if (this.subscriberHead.subscribers === 0) {
            this.self.publisherHead = this.self.publisherHead.next!
            this.self.publisherHead.value = null
            this.self.subscribersIndex += 1
          }
        }
        this.subscriberHead = this.subscriberHead.next!
      }
    }
  }
}

/** @internal */
class SubscriptionImpl<A> implements Queue.Dequeue<A> {
  [queue.DequeueTypeId] = queue.dequeueVariance

  constructor(
    readonly hub: AtomicHub<A>,
    readonly subscribers: Subscribers<A>,
    readonly subscription: Subscription<A>,
    readonly pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>,
    readonly shutdownHook: Deferred.Deferred<never, void>,
    readonly shutdownFlag: MutableRef.MutableRef<boolean>,
    readonly strategy: HubStrategy<A>
  ) {
  }

  capacity(): number {
    return this.hub.capacity
  }

  size(): Effect.Effect<never, never, number> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() =>
        MutableRef.get(this.shutdownFlag)
          ? core.interrupt()
          : core.succeed(this.subscription.size())
      ).traced(trace)
    )
  }

  isFull(): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) =>
      core.map(
        this.size(),
        (size) => size === this.capacity()
      ).traced(trace)
    )
  }

  isEmpty(): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) =>
      core.map(
        this.size(),
        (size) => size === 0
      ).traced(trace)
    )
  }

  shutdown(): Effect.Effect<never, never, void> {
    return Debug.bodyWithTrace((trace) =>
      core.uninterruptible(
        core.withFiberRuntime<never, never, void>((state) => {
          pipe(this.shutdownFlag, MutableRef.set(true))
          return pipe(
            unsafePollAllQueue(this.pollers),
            fiberRuntime.forEachPar((d) => core.deferredInterruptWith(d, state.id())),
            core.zipRight(core.sync(() => this.subscription.unsubscribe())),
            core.zipRight(core.sync(() => this.strategy.unsafeOnHubEmptySpace(this.hub, this.subscribers))),
            core.whenEffect(core.deferredSucceed(this.shutdownHook, void 0)),
            core.asUnit
          )
        }).traced(trace)
      )
    )
  }

  isShutdown(): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) => core.sync(() => MutableRef.get(this.shutdownFlag)).traced(trace))
  }

  awaitShutdown(): Effect.Effect<never, never, void> {
    return Debug.bodyWithTrace((trace) => core.deferredAwait(this.shutdownHook).traced(trace))
  }

  take(): Effect.Effect<never, never, A> {
    return Debug.bodyWithTrace((trace) =>
      core.withFiberRuntime<never, never, A>((state) => {
        if (MutableRef.get(this.shutdownFlag)) {
          return core.interrupt()
        }
        const message = MutableQueue.isEmpty(this.pollers)
          ? this.subscription.poll(MutableQueue.EmptyMutableQueue)
          : MutableQueue.EmptyMutableQueue
        if (message === MutableQueue.EmptyMutableQueue) {
          const deferred = core.deferredUnsafeMake<never, A>(state.id())
          return pipe(
            core.suspend(() => {
              pipe(this.pollers, MutableQueue.offer(deferred))
              pipe(this.subscribers, addSubscribers(this.subscription, this.pollers))
              this.strategy.unsafeCompletePollers(
                this.hub,
                this.subscribers,
                this.subscription,
                this.pollers
              )
              return MutableRef.get(this.shutdownFlag) ? core.interrupt() : core.deferredAwait(deferred)
            }),
            core.onInterrupt(() => core.sync(() => unsafeRemove(this.pollers, deferred)))
          )
        } else {
          this.strategy.unsafeOnHubEmptySpace(this.hub, this.subscribers)
          return core.succeed(message)
        }
      }).traced(trace)
    )
  }

  takeAll(): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() => {
        if (MutableRef.get(this.shutdownFlag)) {
          return core.interrupt()
        }
        const as = MutableQueue.isEmpty(this.pollers)
          ? unsafePollAllSubscription(this.subscription)
          : Chunk.empty()
        this.strategy.unsafeOnHubEmptySpace(this.hub, this.subscribers)
        return core.succeed(as)
      }).traced(trace)
    )
  }

  takeUpTo(this: this, max: number): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() => {
        if (MutableRef.get(this.shutdownFlag)) {
          return core.interrupt()
        }
        const as = MutableQueue.isEmpty(this.pollers)
          ? unsafePollN(this.subscription, max)
          : Chunk.empty()
        this.strategy.unsafeOnHubEmptySpace(this.hub, this.subscribers)
        return core.succeed(as)
      }).traced(trace)
    )
  }

  takeBetween(min: number, max: number): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() => takeRemainderLoop(this, min, max, Chunk.empty())).traced(trace)
    )
  }
}

/** @internal */
const takeRemainderLoop = <A>(
  self: Queue.Dequeue<A>,
  min: number,
  max: number,
  acc: Chunk.Chunk<A>
): Effect.Effect<never, never, Chunk.Chunk<A>> => {
  if (max < min) {
    return core.succeed(acc)
  }
  return pipe(
    self.takeUpTo(max),
    core.flatMap((bs) => {
      const remaining = min - bs.length
      if (remaining === 1) {
        return pipe(self.take(), core.map((b) => pipe(acc, Chunk.concat(bs), Chunk.append(b))))
      }
      if (remaining > 1) {
        return pipe(
          self.take(),
          core.flatMap((b) =>
            takeRemainderLoop(
              self,
              remaining - 1,
              max - bs.length - 1,
              pipe(acc, Chunk.concat(bs), Chunk.append(b))
            )
          )
        )
      }
      return core.succeed(pipe(acc, Chunk.concat(bs)))
    })
  )
}

/** @internal */
class HubImpl<A> implements Hub.Hub<A> {
  readonly [queue.EnqueueTypeId] = queue.enqueueVariance

  constructor(
    readonly hub: AtomicHub<A>,
    readonly subscribers: Subscribers<A>,
    readonly scope: Scope.Scope.Closeable,
    readonly shutdownHook: Deferred.Deferred<never, void>,
    readonly shutdownFlag: MutableRef.MutableRef<boolean>,
    readonly strategy: HubStrategy<A>
  ) {
  }

  capacity(): number {
    return this.hub.capacity
  }

  size(): Effect.Effect<never, never, number> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() =>
        MutableRef.get(this.shutdownFlag) ?
          core.interrupt() :
          core.sync(() => this.hub.size())
      ).traced(trace)
    )
  }

  isFull(): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) =>
      pipe(
        this.size(),
        core.map((size) => size === this.capacity())
      ).traced(trace)
    )
  }

  isEmpty(): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) =>
      pipe(
        this.size(),
        core.map((size) => size === 0)
      ).traced(trace)
    )
  }

  awaitShutdown(): Effect.Effect<never, never, void> {
    return Debug.bodyWithTrace((trace) => core.deferredAwait(this.shutdownHook).traced(trace))
  }

  isShutdown(): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) => core.sync(() => MutableRef.get(this.shutdownFlag)).traced(trace))
  }

  shutdown(): Effect.Effect<never, never, void> {
    return Debug.bodyWithTrace((trace) =>
      core.uninterruptible(core.withFiberRuntime<never, never, void>((state) => {
        pipe(this.shutdownFlag, MutableRef.set(true))
        return pipe(
          this.scope.close(core.exitInterrupt(state.id())),
          core.zipRight(this.strategy.shutdown()),
          core.whenEffect(core.deferredSucceed(this.shutdownHook, void 0)),
          core.asUnit
        )
      })).traced(trace)
    )
  }

  publish(value: A): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() => {
        if (MutableRef.get(this.shutdownFlag)) {
          return core.interrupt()
        }

        if ((this.hub as AtomicHub<unknown>).publish(value)) {
          this.strategy.unsafeCompleteSubscribers(this.hub, this.subscribers)
          return core.succeed(true)
        }

        return this.strategy.handleSurplus(
          this.hub,
          this.subscribers,
          Chunk.of(value),
          this.shutdownFlag
        )
      }).traced(trace)
    )
  }

  publishAll(elements: Iterable<A>): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) =>
      core.suspend(() => {
        if (MutableRef.get(this.shutdownFlag)) {
          return core.interrupt()
        }
        const surplus = unsafePublishAll(this.hub, elements)
        this.strategy.unsafeCompleteSubscribers(this.hub, this.subscribers)
        if (Chunk.isEmpty(surplus)) {
          return core.succeed(true)
        }
        return this.strategy.handleSurplus(
          this.hub,
          this.subscribers,
          surplus,
          this.shutdownFlag
        )
      }).traced(trace)
    )
  }

  subscribe(): Effect.Effect<Scope.Scope, never, Queue.Dequeue<A>> {
    return Debug.bodyWithTrace((trace) =>
      fiberRuntime.acquireRelease(
        pipe(
          makeSubscription(this.hub, this.subscribers, this.strategy),
          core.tap((dequeue) => this.scope.addFinalizer(() => dequeue.shutdown()))
        ),
        (dequeue) => dequeue.shutdown()
      ).traced(trace)
    )
  }

  offer(value: A): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) => this.publish(value).traced(trace))
  }

  offerAll(elements: Iterable<A>): Effect.Effect<never, never, boolean> {
    return Debug.bodyWithTrace((trace) => this.publishAll(elements).traced(trace))
  }
}

/** @internal */
export const makeHub = Debug.methodWithTrace((trace) =>
  <A>(
    hub: AtomicHub<A>,
    strategy: HubStrategy<A>
  ): Effect.Effect<never, never, Hub.Hub<A>> =>
    core.flatMap(fiberRuntime.scopeMake(), (scope) =>
      core.map(core.deferredMake<never, void>(), (deferred) =>
        unsafeMakeHub(
          hub,
          new Map(),
          scope,
          deferred,
          MutableRef.make(false),
          strategy
        ))).traced(trace)
)

/** @internal */
export const unsafeMakeHub = <A>(
  hub: AtomicHub<A>,
  subscribers: Subscribers<A>,
  scope: Scope.Scope.Closeable,
  shutdownHook: Deferred.Deferred<never, void>,
  shutdownFlag: MutableRef.MutableRef<boolean>,
  strategy: HubStrategy<A>
): Hub.Hub<A> => {
  return new HubImpl(hub, subscribers, scope, shutdownHook, shutdownFlag, strategy)
}

/** @internal */
const nextPow2 = (n: number): number => {
  const nextPow = Math.ceil(Math.log(n) / Math.log(2.0))
  return Math.max(Math.pow(2, nextPow), 2)
}

/** @internal */
const ensureCapacity = (capacity: number): void => {
  if (capacity <= 0) {
    throw cause.InvalidHubCapacityException(`Cannot construct Hub with capacity of ${capacity}`)
  }
}

/** @internal */
const unsafeCompleteDeferred = <A>(deferred: Deferred.Deferred<never, A>, a: A): void => {
  core.deferredUnsafeDone(deferred, core.succeed(a))
}

/** @internal */
const unsafeOfferAll = <A>(queue: MutableQueue.MutableQueue<A>, as: Iterable<A>): Chunk.Chunk<A> => {
  return pipe(queue, MutableQueue.offerAll(as))
}

/** @internal */
const unsafePollAllQueue = <A>(queue: MutableQueue.MutableQueue<A>): Chunk.Chunk<A> => {
  return pipe(queue, MutableQueue.pollUpTo(Number.POSITIVE_INFINITY))
}

/** @internal */
const unsafePollAllSubscription = <A>(subscription: Subscription<A>): Chunk.Chunk<A> => {
  return subscription.pollUpTo(Number.POSITIVE_INFINITY)
}

/** @internal */
const unsafePollN = <A>(subscription: Subscription<A>, max: number): Chunk.Chunk<A> => {
  return subscription.pollUpTo(max)
}

/** @internal */
const unsafePublishAll = <A>(hub: AtomicHub<A>, as: Iterable<A>): Chunk.Chunk<A> => {
  return hub.publishAll(as)
}

/** @internal */
const unsafeRemove = <A>(queue: MutableQueue.MutableQueue<A>, value: A): void => {
  unsafeOfferAll(
    queue,
    pipe(unsafePollAllQueue(queue), Chunk.filter((elem) => elem !== value))
  )
}

// -----------------------------------------------------------------------------
// Hub.Strategy
// -----------------------------------------------------------------------------

/**
 * A `HubStrategy<A>` describes the protocol for how publishers and subscribers
 * will communicate with each other through the hub.
 *
 * @internal
 */
export interface HubStrategy<A> {
  /**
   * Describes any finalization logic associated with this strategy.
   */
  shutdown(): Effect.Effect<never, never, void>

  /**
   * Describes how publishers should signal to subscribers that they are
   * waiting for space to become available in the hub.
   */
  handleSurplus(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    elements: Iterable<A>,
    isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<never, never, boolean>

  /**
   * Describes how subscribers should signal to publishers waiting for space
   * to become available in the hub that space may be available.
   */
  unsafeOnHubEmptySpace(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>
  ): void

  /**
   * Describes how subscribers waiting for additional values from the hub
   * should take those values and signal to publishers that they are no
   * longer waiting for additional values.
   */
  unsafeCompletePollers(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    subscription: Subscription<A>,
    pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
  ): void

  /**
   * Describes how publishers should signal to subscribers waiting for
   * additional values from the hub that new values are available.
   */
  unsafeCompleteSubscribers(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>
  ): void
}

/**
 * A strategy that applies back pressure to publishers when the hub is at
 * capacity. This guarantees that all subscribers will receive all messages
 * published to the hub while they are subscribed. However, it creates the
 * risk that a slow subscriber will slow down the rate at which messages
 * are published and received by other subscribers.
 *
 * @internal
 */
class BackPressureStrategy<A> implements HubStrategy<A> {
  publishers: MutableQueue.MutableQueue<
    readonly [
      A,
      Deferred.Deferred<never, boolean>,
      boolean
    ]
  > = MutableQueue.unbounded()

  shutdown(): Effect.Effect<never, never, void> {
    return core.flatMap(core.fiberId(), (fiberId) =>
      core.flatMap(
        core.sync(() => unsafePollAllQueue(this.publishers)),
        (publishers) =>
          fiberRuntime.forEachParDiscard(publishers, ([_, deferred, last]) =>
            last ?
              pipe(core.deferredInterruptWith(deferred, fiberId), core.asUnit) :
              core.unit())
      ))
  }

  handleSurplus(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    elements: Iterable<A>,
    isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<never, never, boolean> {
    return core.withFiberRuntime<never, never, boolean>((state) => {
      const deferred = core.deferredUnsafeMake<never, boolean>(state.id())
      return pipe(
        core.suspend(() => {
          this.unsafeOffer(elements, deferred)
          this.unsafeOnHubEmptySpace(hub, subscribers)
          this.unsafeCompleteSubscribers(hub, subscribers)
          return MutableRef.get(isShutdown) ?
            core.interrupt() :
            core.deferredAwait(deferred)
        }),
        core.onInterrupt(() => core.sync(() => this.unsafeRemove(deferred)))
      )
    })
  }

  unsafeOnHubEmptySpace(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>
  ): void {
    let keepPolling = true
    while (keepPolling && !hub.isFull()) {
      const publisher = pipe(this.publishers, MutableQueue.poll(MutableQueue.EmptyMutableQueue))
      if (publisher === MutableQueue.EmptyMutableQueue) {
        keepPolling = false
      } else {
        const published = hub.publish(publisher[0])
        if (published && publisher[2]) {
          unsafeCompleteDeferred(publisher[1], true)
        } else if (!published) {
          unsafeOfferAll(
            this.publishers,
            pipe(unsafePollAllQueue(this.publishers), Chunk.prepend(publisher))
          )
        }
        this.unsafeCompleteSubscribers(hub, subscribers)
      }
    }
  }

  unsafeCompletePollers(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    subscription: Subscription<A>,
    pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
  ): void {
    return unsafeStrategyCompletePollers(this, hub, subscribers, subscription, pollers)
  }

  unsafeCompleteSubscribers(hub: AtomicHub<A>, subscribers: Subscribers<A>): void {
    return unsafeStrategyCompleteSubscribers(this, hub, subscribers)
  }

  private unsafeOffer(elements: Iterable<A>, deferred: Deferred.Deferred<never, boolean>): void {
    const iterator = elements[Symbol.iterator]()
    let next: IteratorResult<A> = iterator.next()
    if (!next.done) {
      // eslint-disable-next-line no-constant-condition
      while (1) {
        const value = next.value
        next = iterator.next()
        if (next.done) {
          pipe(
            this.publishers,
            MutableQueue.offer([value, deferred, true as boolean] as const)
          )
          break
        }
        pipe(
          this.publishers,
          MutableQueue.offer([value, deferred, false as boolean] as const)
        )
      }
    }
  }

  unsafeRemove(deferred: Deferred.Deferred<never, boolean>): void {
    unsafeOfferAll(
      this.publishers,
      pipe(unsafePollAllQueue(this.publishers), Chunk.filter(([_, a]) => a !== deferred))
    )
  }
}

/**
 * A strategy that drops new messages when the hub is at capacity. This
 * guarantees that a slow subscriber will not slow down the rate at which
 * messages are published. However, it creates the risk that a slow
 * subscriber will slow down the rate at which messages are received by
 * other subscribers and that subscribers may not receive all messages
 * published to the hub while they are subscribed.
 *
 * @internal
 */
export class DroppingStrategy<A> implements HubStrategy<A> {
  shutdown(): Effect.Effect<never, never, void> {
    return core.unit()
  }

  handleSurplus(
    _hub: AtomicHub<A>,
    _subscribers: Subscribers<A>,
    _elements: Iterable<A>,
    _isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<never, never, boolean> {
    return core.succeed(false)
  }

  unsafeOnHubEmptySpace(
    _hub: AtomicHub<A>,
    _subscribers: Subscribers<A>
  ): void {
    //
  }

  unsafeCompletePollers(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    subscription: Subscription<A>,
    pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
  ): void {
    return unsafeStrategyCompletePollers(this, hub, subscribers, subscription, pollers)
  }

  unsafeCompleteSubscribers(hub: AtomicHub<A>, subscribers: Subscribers<A>): void {
    return unsafeStrategyCompleteSubscribers(this, hub, subscribers)
  }
}

/**
 * A strategy that adds new messages and drops old messages when the hub is
 * at capacity. This guarantees that a slow subscriber will not slow down
 * the rate at which messages are published and received by other
 * subscribers. However, it creates the risk that a slow subscriber will
 * not receive some messages published to the hub while it is subscribed.
 *
 * @internal
 */
export class SlidingStrategy<A> implements HubStrategy<A> {
  shutdown(): Effect.Effect<never, never, void> {
    return core.unit()
  }

  handleSurplus(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    elements: Iterable<A>,
    _isShutdown: MutableRef.MutableRef<boolean>
  ): Effect.Effect<never, never, boolean> {
    return core.sync(() => {
      this.unsafeSlidingPublish(hub, elements)
      this.unsafeCompleteSubscribers(hub, subscribers)
      return true
    })
  }

  unsafeOnHubEmptySpace(
    _hub: AtomicHub<A>,
    _subscribers: Subscribers<A>
  ): void {
    //
  }

  unsafeCompletePollers(
    hub: AtomicHub<A>,
    subscribers: Subscribers<A>,
    subscription: Subscription<A>,
    pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
  ): void {
    return unsafeStrategyCompletePollers(this, hub, subscribers, subscription, pollers)
  }

  unsafeCompleteSubscribers(hub: AtomicHub<A>, subscribers: Subscribers<A>): void {
    return unsafeStrategyCompleteSubscribers(this, hub, subscribers)
  }

  unsafeSlidingPublish(hub: AtomicHub<A>, elements: Iterable<A>): void {
    const it = elements[Symbol.iterator]()
    let next = it.next()
    if (!next.done && hub.capacity > 0) {
      let a = next.value
      let loop = true
      while (loop) {
        hub.slide()
        const pub = hub.publish(a)
        if (pub && (next = it.next()) && !next.done) {
          a = next.value
        } else if (pub) {
          loop = false
        }
      }
    }
  }
}

/** @internal */
const unsafeStrategyCompletePollers = <A>(
  strategy: HubStrategy<A>,
  hub: AtomicHub<A>,
  subscribers: Subscribers<A>,
  subscription: Subscription<A>,
  pollers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>
): void => {
  let keepPolling = true
  while (keepPolling && !subscription.isEmpty()) {
    const poller = pipe(pollers, MutableQueue.poll(MutableQueue.EmptyMutableQueue))
    if (poller === MutableQueue.EmptyMutableQueue) {
      pipe(subscribers, removeSubscribers(subscription, pollers))
      if (MutableQueue.isEmpty(pollers)) {
        keepPolling = false
      } else {
        pipe(subscribers, addSubscribers(subscription, pollers))
      }
    } else {
      const pollResult = subscription.poll(MutableQueue.EmptyMutableQueue)
      if (pollResult === MutableQueue.EmptyMutableQueue) {
        unsafeOfferAll(pollers, pipe(unsafePollAllQueue(pollers), Chunk.prepend(poller)))
      } else {
        unsafeCompleteDeferred(poller, pollResult)
        strategy.unsafeOnHubEmptySpace(hub, subscribers)
      }
    }
  }
}

/** @internal */
const unsafeStrategyCompleteSubscribers = <A>(
  strategy: HubStrategy<A>,
  hub: AtomicHub<A>,
  subscribers: Subscribers<A>
): void => {
  for (
    const [subscription, pollersSet] of subscribers
  ) {
    for (const pollers of pollersSet) {
      strategy.unsafeCompletePollers(hub, subscribers, subscription, pollers)
    }
  }
}
