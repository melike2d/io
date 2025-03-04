import * as Effect from "@effect/io/Effect"
import * as Exit from "@effect/io/Exit"
import * as Request from "@effect/io/Request"
import * as Resolver from "@effect/io/RequestResolver"
import * as it from "@effect/io/test/utils/extend"

export const userIds: ReadonlyArray<number> = [1, 1]

interface GetNameById extends Request.Request<string, string> {
  readonly _tag: "GetNameById"
  readonly id: number
}
const GetNameById = Request.tagged<GetNameById>("GetNameById")

const UserResolver = Resolver.makeBatched((requests: Array<GetNameById>) =>
  Effect.forEachDiscard(requests, (request) =>
    Request.complete(
      request,
      Exit.succeed("ok")
    ))
)

const getUserNameById = (id: number) => Effect.request(GetNameById({ id }), UserResolver)
const getAllUserNames = Effect.forEachPar([1, 1], getUserNameById)

describe.concurrent("Effect", () => {
  it.it("requests are executed correctly", () =>
    Effect.runPromise(
      Effect.gen(function*($) {
        yield* $(
          getAllUserNames,
          Effect.withRequestCaching("on"),
          Effect.withRequestBatching("on")
        )
      })
    ))
})
