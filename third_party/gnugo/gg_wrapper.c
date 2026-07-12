/* gg_wrapper.c — GNU Go를 웹 워커에서 무상태로 쓰기 위한 최소 래퍼.
 *
 * 앱 쪽 워커 프로토콜이 "매 요청마다 전체 국면 전달"이라, 요청 한 번에
 * 보드 세팅 → 착수 생성까지 끝내는 단일 진입점(gg_genmove_pos)만 노출한다.
 * 색 인코딩은 앱 기준(1=흑, 2=백)을 받아 GNU Go 기준(BLACK/WHITE)으로 변환.
 */
#include <emscripten.h>

#include "gnugo.h"
#include "liberty.h"

static int gg_inited = 0;

/* board: size*size 바이트(행 우선, 0=빈점 1=흑 2=백), turn: 둘 색(1=흑 2=백),
 * ko_i/ko_j: 패로 되따냄이 금지된 점(없으면 -1), komi10: 코미×10, level: 1~10.
 * 반환: i*32+j (착수), -1 = 패스, -2 = 불계(GNU Go가 투료 판단). */
int EMSCRIPTEN_KEEPALIVE gg_genmove_pos(const unsigned char *board, int size,
                                        int turn, int ko_i, int ko_j,
                                        int komi10, int level, int seed) {
  int i, j;
  float value;
  int resign;
  int move;
  int gcolor = (turn == 1) ? BLACK : WHITE;

  if (!gg_inited) {
    init_gnugo((float) DEFAULT_MEMORY, seed);
    gg_inited = 1;
  }
  chinese_rules = 1;
  komi = komi10 / 10.0f;
  set_level(level);
  gnugo_clear_board(size);

  for (i = 0; i < size; i++) {
    for (j = 0; j < size; j++) {
      unsigned char v = board[i * size + j];
      if (v == 1) add_stone(POS(i, j), BLACK);
      else if (v == 2) add_stone(POS(i, j), WHITE);
    }
  }
  if (ko_i >= 0 && ko_j >= 0) board_ko_pos = POS(ko_i, ko_j);

  move = genmove(gcolor, &value, &resign);
  if (resign) return -2;
  if (is_pass(move)) return -1;
  return I(move) * 32 + J(move);
}
