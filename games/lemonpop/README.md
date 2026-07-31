# Lemon Pop

Lemon Pop is a 5×5 no-refill cascade game. Horizontal and vertical straight runs of 3–5 symbols pay; a cross pays once in each direction.

- All 15 non-wild Lemon Pop tiles appear on the reel strips. The `lemonpop` can is a persistent wild created only by wins and Pop Rush effects.
- Each paying run is removed, leaves a new 1× wild can at its centre, and the remaining symbols fall. Empty top cells are never refilled.
- A natural single-symbol run with wilds pays full. Mixed premium runs pay half of the best premium; mixed regular runs do not pay. All-wild runs use the Wild Can ladder.
- A 2× wild can doubles a winning run once; it is consumed when used. Four winning base cascades award one free Pop Rush respin, with no retrigger.
- Pop Rush randomly selects one seeded effect: **Pop Rush**, **Citrus Cross**, **Flavor Remix**, or **Soda Storm**.

The implementation uses `core/math/StraightLineMath.js`, `core/math/LemonPopFeatures.js`, and `core/engine/mechanics/LemonPopSpinMechanic.js`; live play, the simulator, and workers share the same mechanic.
