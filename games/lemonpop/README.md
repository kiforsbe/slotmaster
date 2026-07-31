# Lemon Pop

Lemon Pop is a 5×5 no-refill cascade game. Horizontal and vertical straight runs of 3–5 symbols pay; a cross pays once in each direction.

- **Premiums:** Lemon Ice, Pink Pop, Pink Fizz. **Normal symbols:** Lemon Wedge, Gumdrop, Lemon Heart, Lemon Candy. The `lemonpop` can is a persistent wild created only by wins and Pop Rush effects.
- Each paying run is removed, leaves a new 1× wild can at its centre, and the remaining symbols fall. Empty top cells are never refilled.
- A natural single-symbol run with wilds pays full. Mixed premium runs pay half of the best premium; mixed regular runs do not pay. All-wild runs use the Wild Can ladder.
- A 2× wild can doubles a winning run once; it is consumed when used. Every five winning lines fills one Pop. Each filled Pop immediately performs one seeded board effect: **Wild Splash** adds one or two wild cans, **Flavor Shift** changes a landed natural symbol, or **Bubble Burst** removes two matching pairs.
- Filling all three Pops unlocks one free, non-retriggering Pop Rush respin. Pop Rush randomly selects **Pop Rush**, **Citrus Cross**, **Flavor Remix**, or **Soda Storm**.

The implementation uses `core/math/StraightLineMath.js`, `core/math/LemonPopFeatures.js`, and `core/engine/mechanics/LemonPopSpinMechanic.js`; live play, the simulator, and workers share the same mechanic.
