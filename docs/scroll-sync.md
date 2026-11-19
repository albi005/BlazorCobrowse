# Scroll sync

How the agent's mirror and the customer's page stay in step. This is the part
that took the most iteration, so the invariants matter more than the code.

## Why it is relative

The original PoC (`~/.t3/scratch/2026-11-17-hi-investigate-openreplay-i-need-9ec5f306/CobrowseDemo`)
never mirrors absolute scroll positions. The agent sends a **relative delta**
and the customer applies it with `scrollBy`. Absolute positions make the two
sides fight over the final offset, which is what "wobbly" scrolling looked like.

The first implementation here used absolute positions plus a proportional
mapping. It echoed: the agent scrolled, the customer scrolled, the replay of
that scroll came back to the agent and pushed the mirror, which sent another
position. The fix was to copy the PoC's model.

## Protocol

One hub message, `Control`, with `action: "scroll"` and a string value:

```json
{ "requestId": "r_…", "nodeId": "", "action": "scroll", "value": "{\"top\":120,\"left\":0}" }
```

- `top` / `left` are **deltas in CSS pixels**, not positions.
- `nodeId` empty means the page scroller. A non-empty id means that element is
  the scroll container.
- The value travels as a JSON string so protocol-1 peers can ignore it.

`cobrowse-capture.js` also still understands `action: "scrollTo"` with
`{ top, left, maxTop, maxLeft }` and maps by proportion. Nothing sends it any
more; it stays for older agents and as a fallback path.

The hub drops scroll commands unless the session has **both** view and control
consent (`CobrowseHub.Control`).

## Agent side (`src/CobrowseService/wwwroot/js/cobrowse-agent.js`)

### Gestures

| Input | What the mirror does | What the customer gets |
| --- | --- | --- |
| Wheel | scrolls natively (instant feedback) | the same delta, merged |
| Touch drag | driven manually (`scrollTop += dy`) | the same delta |
| Arrow / Page / Space | driven manually | the same delta |
| "Scroll down" button | driven manually | the same delta |

Wheel scrolls natively so the agent sees movement immediately. Touch and
keyboard are driven manually because native momentum would overshoot the delta
the customer receives.

### Inner containers

Every gesture resolves its target from `event.target` up to the nearest
scrollable ancestor (`scrollableAncestor`): an element whose computed
`overflow-x`/`overflow-y` is `auto`, `scroll` or `overlay` and whose content is
actually larger than its box. If there is none, the document scroller is the
target. The target's `data-cb-id` becomes the `nodeId`; the page itself uses an
empty id, so the wire format and the customer's `scrollBy` path are unchanged.

`queueScroll` already keys its merge map by `nodeId`, so wheel bursts over
several containers merge independently and one flush sends one message per
container.

### Merging

`queueScroll(nodeId, dx, dy)` accumulates deltas in a `Map` keyed by node id and
flushes once every **40 ms**. A burst of wheel ticks becomes one round-trip.

### Deltas come from real movement

The delta is not the raw wheel event. It is the change in the mirror's actual
`scrollTop`/`scrollLeft`, measured in the scroll listener. Reading positions
instead of trusting `event.deltaY` makes line-mode wheels (Firefox mice),
browser smoothing and momentum all arrive as the same number of pixels the
mirror really moved. The position map is seeded from the scroller on attach and
on pointer move, so the first tick already has a baseline.

Only movement inside the gesture window is forwarded; a scroll outside it is
the customer's replay and must not be echoed back. Each forwarded delta
extends the window by 250 ms so trailing momentum is included.

### Echo suppression

The mirror receives the customer's replay of the same scroll. Without a guard
that replay pulls the mirror back to an older position mid-gesture.

Two mechanisms:

1. `agentScrollUntil` — set to `now + 600 ms` on every gesture. Scroll events
   that arrive before it are dropped in `apply()`.
2. `agentScrollTarget` — set to the position the agent just scrolled to, with a
   `now + 1500 ms` deadline. A replayed scroll event for the **document** is
   dropped while it is away from that target, and the guard clears as soon as
   the replay reaches it (within 2 px). Inner-container echoes do not have a
   stable rrweb id to map back to `data-cb-id`, so they rely only on the 600 ms
   window; the delta model means the echo lands on the same position anyway.

The wheel handler reads the real position on the next frame instead of
predicting `scrollTop + delta`: the browser may apply the native scroll before
the passive wheel listener runs, so a prediction double-counts the delta and the
guard waits for a position the customer never reaches.

### Instant replay

rrweb's replayer applies scroll events with `behavior: 'smooth'` unless the
event is marked synchronous. That animation fights the agent's own scroll. The
module wraps `replayer.applyScroll` and always passes `true`:

```js
const originalApplyScroll = replayer.applyScroll.bind(replayer);
replayer.applyScroll = (event) => originalApplyScroll(event, true);
```

### Mirror sizing

The mirror is rendered at the **customer's native viewport size** with no CSS
scale. The earlier scaled version made the agent's wheel pixels and the
document's scroll pixels disagree, which reintroduced the wobble. The shell
scrolls/pans when the customer's page is wider than the agent's panel.

Consequence: on a wide customer page with a narrow agent panel the agent must
pan horizontally instead of seeing a scaled-down whole page. That is the
accepted trade-off. If scaling is ever added back, the wheel delta must be
divided by the scale factor too, or the mapping breaks again.

## Customer side (`src/App.Cobrowse/wwwroot/js/cobrowse-capture.js`)

`applyControl(…, 'scroll', …)` parses the JSON (or a bare number for legacy
clients) and calls `setScroll(scroller, scrollTop + top, scrollLeft + left)`.

`setScroll` uses `scrollTo({ behavior: 'instant' })`. Bootstrap sets
`scroll-behavior: smooth` on `:root`, and **both** `scrollBy({behavior:'auto'})`
and assigning `scrollTop` obey it. With smooth scrolling, each 40 ms delta
interrupted the previous animation and lost the remaining distance; the
customer fell further behind the agent with every wheel tick, and a click
"fixed" it only because the click handler scrolls the target into view. The
instant behaviour is the fix; the fallback temporarily sets the inline style to
`auto` for browsers without `'instant'`.

## Cursor dot (customer side)

The agent sends `Cursor` with both viewport percentages and document
coordinates. The customer prefers document coordinates (`docX`/`docY`), so the
dot stays anchored to the same point in the page when either side scrolls. It
falls back to viewport percentages for older agents.

The agent's `scroll` listener does **not** send scroll commands; it only
refreshes the cursor dot and measures movement (see above). Sending from there
would create the echo loop again.

## Customer cursor (agent side)

rrweb's mousemove (source 1) and touchmove (source 6) events carry the
customer's `clientX`/`clientY`. The agent draws a blue "Customer" dot in the
mirror iframe at those viewport coordinates. It is `position: fixed`, so
scrolling the mirror does not drag it, and it fades after 3 s without movement.
A full-snapshot rebuild replaces the iframe; the dot is recreated lazily on the
next move.

## Known limitations

- **No scroll chaining.** When an inner container reaches its end, the agent's
  browser may chain the rest of the wheel to the page, while the customer's
  container simply stops. A wheel that starts on a container never scrolls the
  customer's page. Move the pointer off the container to scroll the page.
- **Horizontal panning.** See the sizing note above.
- **Scrollbar visibility.** The mirror iframe renders at native size, so the
  customer's scrollbars are visible inside the iframe. That is expected.
- **Wheel over the iframe.** The pointer must be over the mirror's iframe, not
  the empty wrapper area beside a narrow customer page. This is only a testing
  gotcha; the verify script picks a point inside the iframe.

## Verifying

`scripts/verify-scroll-sync.js` runs the whole matrix headlessly. It checks
customer→agent, the "Scroll down" button, the agent wheel, wobble (the mirror
must hold still after settling), cursor anchoring, and that the mirror document
matches the customer's viewport size. `scripts/verify-interactions.js` also
covers the inner scroll container in both directions (the sample page has
`#sample-scroller`). See the README for how to run them.
