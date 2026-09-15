# Time Trotter

Open `index.html` in any modern desktop or mobile browser. It is a self-contained memory card game supporting both real-time online multiplayer and local pass-and-play.

## Included rules

- 36-card deck: red, blue, and green copies of 0–9, +2, and +4.
- Three-player deal: 10 cards each plus a 2 × 3 memory matrix.
- Four-player deal: 8 cards each plus a 2 × 2 memory matrix.
- Five-player deal: 6 cards each plus a 2 × 3 memory matrix.
- Hands stay privately sorted from 0 through +4.
- Each turn has two clues. A clue asks another player for their high or low card, or flips one matrix card.
- Other-player answers appear as a five-second popup, then disappear. Matrix cards reveal in place for five seconds and turn face down again.
- Two distinct clues that show the same value earn one bonus clue.
- A player wins by completing three triplets, or immediately by completing the 7 triplet.

## Memory-first interpretation

No public answer log or location marker is retained. The game engine remembers whether a card has been discovered so it can validate a claimed set, but the players must remember the values and locations themselves.

Cards never change hands after a clue. When a player calls a valid triplet, all three matching cards are removed from the game at once: from every respective owner and/or the matrix, including the caller's own matching card. This preserves the document's core mind-game of private hands, short public answers, a face-down shared matrix, and strategic memory.
