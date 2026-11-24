// Observe both promises immediately so an early event timeout cannot bypass cleanup.
export async function browserAction(pending, action) {
  const [event] = await Promise.all([pending, Promise.resolve().then(action)])
  return event
}
