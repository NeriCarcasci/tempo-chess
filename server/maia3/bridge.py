"""Persistent JSON-lines bridge from Forma to the Maia-3 policy model.

The upstream UCI wrapper deliberately emits only ranked moves and WDL values.
Forma needs the actual policy probabilities so it can cache one inference and
sample a stable reply for each continuation turn.  This bridge uses the same
upstream model/tokenisation code, but returns every legal move probability as
one JSON object per input line.

Input:  {"fen": "...", "rating": 1500}
Output: {"moves": [{"uci": "e2e4", "probability": 0.31}, ...]}
"""

import argparse
import json
import sys

import torch
from maia3.dataset import get_legal_moves_mask
from maia3.uci import Maia3UCIEngine, parse_args as parse_maia_args


def build_engine(checkpoint_path: str) -> Maia3UCIEngine:
    cfg = parse_maia_args(
        [
            "--model",
            "maia3-5m",
            "--checkpoint-path",
            checkpoint_path,
            "--device",
            "cpu",
            "--no-use-amp",
            "--temperature",
            "0",
        ]
    )
    engine = Maia3UCIEngine(cfg)
    engine.ensure_model_loaded()
    return engine


@torch.no_grad()
def policy(engine: Maia3UCIEngine, fen: str, rating: int) -> list[dict[str, object]]:
    engine.cmd_ucinewgame()
    engine.cmd_position(f"position fen {fen}")
    engine.self_elo = rating
    engine.oppo_elo = rating

    legal_mask = get_legal_moves_mask(engine.board, engine.all_moves_dict)
    if not bool(legal_mask.any()):
        return []

    tokens = engine._tokens_from_history(engine.history).unsqueeze(0).to(engine.cfg.device)
    self_elos = torch.tensor([rating], dtype=torch.long, device=engine.cfg.device)
    opponent_elos = torch.tensor([rating], dtype=torch.long, device=engine.cfg.device)
    logits_move, _logits_value, _ = engine.model(tokens, self_elos, opponent_elos)
    logits = logits_move[0].float().masked_fill(~legal_mask.to(engine.cfg.device), float("-inf"))
    probabilities = torch.softmax(logits, dim=-1)

    moves: list[dict[str, object]] = []
    for index in torch.nonzero(legal_mask, as_tuple=False).flatten().tolist():
        move = engine._move_from_index(index)
        if move is not None:
            moves.append({"uci": move.uci(), "probability": float(probabilities[index].item())})
    moves.sort(key=lambda item: (-float(item["probability"]), str(item["uci"])))
    return moves


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint-path", required=True)
    args = parser.parse_args()
    engine = build_engine(args.checkpoint_path)
    print(json.dumps({"ready": True}), flush=True)

    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            fen = str(request["fen"])
            rating = int(request["rating"])
            result = {"moves": policy(engine, fen, rating)}
        except Exception as error:  # Keep the process alive; Node classifies the request failure.
            result = {"error": type(error).__name__}
        print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
