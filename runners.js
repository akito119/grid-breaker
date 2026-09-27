export const LANGUAGES = Object.freeze({
  python: {
    label: "Python 3.13",
    compiler: "cpython-3.13.8",
    editorLanguage: "python",
    template: `def attack(n, m, start, targets, step_limit, move):
    row, col = start
    remaining = list(targets)
    steps = 0

    while remaining and steps < step_limit:
        target = min(remaining, key=lambda t: abs(row - t[0]) + abs(col - t[1]))
        tr, tc, hp = target

        # 現在地と弱点が重なる場合は、一度離れて戻る
        if (row, col) == (tr, tc) and steps + 2 <= step_limit:
            nr = row + 1 if row + 1 < n else row - 1
            move(nr, col); move(row, col)
            steps += 2

        while row != tr and steps < step_limit:
            row += 1 if row < tr else -1
            move(row, col); steps += 1
        while col != tc and steps < step_limit:
            col += 1 if col < tc else -1
            move(row, col); steps += 1

        remaining.remove(target)`,
  },
  cpp: {
    label: "GCC 13.2 · C++20",
    compiler: "gcc-13.2.0",
    editorLanguage: "cpp",
    template: `void attack(int n, int m, Position start,
            const vector<Target>& targets, int stepLimit, const Move& move) {
    int row = start.row, col = start.col, steps = 0;
    vector<Target> remaining = targets;

    while (!remaining.empty() && steps < stepLimit) {
        auto it = min_element(remaining.begin(), remaining.end(), [&](const Target& a, const Target& b) {
            return abs(row - a.row) + abs(col - a.col) < abs(row - b.row) + abs(col - b.col);
        });
        Target target = *it;

        if (row == target.row && col == target.col && steps + 2 <= stepLimit) {
            int nextRow = row + 1 < n ? row + 1 : row - 1;
            move(nextRow, col); move(row, col); steps += 2;
        }
        while (row != target.row && steps < stepLimit) {
            row += row < target.row ? 1 : -1; move(row, col); ++steps;
        }
        while (col != target.col && steps < stepLimit) {
            col += col < target.col ? 1 : -1; move(row, col); ++steps;
        }
        remaining.erase(it);
    }
}`,
  },
  java: {
    label: "OpenJDK 21",
    compiler: "openjdk-jdk-21+35",
    editorLanguage: "java",
    template: `static void attack(int n, int m, Position start,
        List<Target> targets, int stepLimit, Move move) {
    int row = start.row(), col = start.col(), steps = 0;
    List<Target> remaining = new ArrayList<>(targets);

    while (!remaining.isEmpty() && steps < stepLimit) {
        final int currentRow = row, currentCol = col;
        Target target = Collections.min(remaining, Comparator.comparingInt(
            t -> Math.abs(currentRow - t.row()) + Math.abs(currentCol - t.col())));

        if (row == target.row() && col == target.col() && steps + 2 <= stepLimit) {
            int nextRow = row + 1 < n ? row + 1 : row - 1;
            move.go(nextRow, col); move.go(row, col); steps += 2;
        }
        while (row != target.row() && steps < stepLimit) {
            row += row < target.row() ? 1 : -1; move.go(row, col); steps++;
        }
        while (col != target.col() && steps < stepLimit) {
            col += col < target.col() ? 1 : -1; move.go(row, col); steps++;
        }
        remaining.remove(target);
    }
}`,
  },
});

function pythonLiteral(game) {
  return `[${game.weakpoints.filter((point) => point.hp > 0).map((point) => `(${point.row}, ${point.col}, ${point.hp})`).join(", ")}]`;
}

function cppTargets(game) {
  return `{${game.weakpoints.filter((point) => point.hp > 0).map((point) => `{${point.row}, ${point.col}, ${point.hp}}`).join(", ")}}`;
}

function javaTargets(game) {
  return `List.of(${game.weakpoints.filter((point) => point.hp > 0).map((point) => `new Target(${point.row}, ${point.col}, ${point.hp})`).join(", ")})`;
}

export function buildSource(language, userCode, game) {
  const captureLimit = game.stepLimit + 1;
  const [startRow, startCol] = game.current;

  if (language === "python") {
    return `import resource
import time

${userCode}

__gb_path = []
def __gb_move(row, col):
    if len(__gb_path) < ${captureLimit}:
        __gb_path.append((int(row), int(col)))

__gb_start = time.perf_counter_ns()
attack(${game.rows}, ${game.cols}, (${startRow}, ${startCol}), ${pythonLiteral(game)}, ${game.stepLimit}, __gb_move)
__gb_elapsed = (time.perf_counter_ns() - __gb_start) / 1_000_000
__gb_memory = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print("__GB_PATH_BEGIN__")
for __gb_row, __gb_col in __gb_path:
    print(f"{__gb_row} {__gb_col}")
print("__GB_PATH_END__")
print(f"__GB_METRICS__ {__gb_elapsed:.6f} {__gb_memory}")
`;
  }

  if (language === "cpp") {
    return `#include <bits/stdc++.h>
#include <sys/resource.h>
using namespace std;

struct Position { int row; int col; };
struct Target { int row; int col; int hp; };
using Move = function<void(int, int)>;

${userCode}

int main() {
    vector<pair<int, int>> path;
    path.reserve(${captureLimit});
    Move move = [&](int row, int col) {
        if (path.size() < ${captureLimit}) path.emplace_back(row, col);
    };
    const vector<Target> targets = ${cppTargets(game)};
    const auto started = chrono::steady_clock::now();
    attack(${game.rows}, ${game.cols}, {${startRow}, ${startCol}}, targets, ${game.stepLimit}, move);
    const double elapsed = chrono::duration<double, milli>(chrono::steady_clock::now() - started).count();
    rusage usage{};
    getrusage(RUSAGE_SELF, &usage);
    cout << "__GB_PATH_BEGIN__\\n";
    for (const auto& [row, col] : path) cout << row << ' ' << col << '\\n';
    cout << "__GB_PATH_END__\\n";
    cout << fixed << setprecision(6) << "__GB_METRICS__ " << elapsed << ' ' << usage.ru_maxrss << '\\n';
}
`;
  }

  const indented = userCode.split("\n").map((line) => `    ${line}`).join("\n");
  return `import java.util.*;

class Main {
    record Position(int row, int col) {}
    record Target(int row, int col, int hp) {}
    interface Move { void go(int row, int col); }

${indented}

    public static void main(String[] args) {
        List<int[]> path = new ArrayList<>(${captureLimit});
        Move move = (row, col) -> {
            if (path.size() < ${captureLimit}) path.add(new int[]{row, col});
        };
        List<Target> targets = ${javaTargets(game)};
        Runtime runtime = Runtime.getRuntime();
        long memoryBefore = runtime.totalMemory() - runtime.freeMemory();
        long started = System.nanoTime();
        attack(${game.rows}, ${game.cols}, new Position(${startRow}, ${startCol}), targets, ${game.stepLimit}, move);
        double elapsed = (System.nanoTime() - started) / 1_000_000.0;
        long memoryAfter = runtime.totalMemory() - runtime.freeMemory();
        long memoryKb = Math.max(memoryBefore, memoryAfter) / 1024;
        StringBuilder output = new StringBuilder("__GB_PATH_BEGIN__\\n");
        for (int[] cell : path) output.append(cell[0]).append(' ').append(cell[1]).append('\\n');
        output.append("__GB_PATH_END__\\n");
        output.append(String.format(Locale.ROOT, "__GB_METRICS__ %.6f %d\\n", elapsed, memoryKb));
        System.out.print(output);
    }
}
`;
}

export function createWandboxRequest(language, source) {
  const config = LANGUAGES[language];
  const request = {
    compiler: config.compiler,
    code: source,
    stdin: "",
    options: "",
    save: false,
  };
  if (language === "cpp") {
    request["compiler-option-raw"] = "-std=gnu++20\n-O2\n-Wall\n-Wextra";
  }
  return request;
}

export function parseProgramOutput(output) {
  const lines = String(output || "").split(/\r?\n/);
  const start = lines.indexOf("__GB_PATH_BEGIN__");
  const end = lines.indexOf("__GB_PATH_END__", start + 1);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("経路マーカーを取得できませんでした。プログラムが最後まで実行されたか確認してください。");
  }

  const path = lines.slice(start + 1, end).filter(Boolean).map((line, index) => {
    const match = line.trim().match(/^(-?\d+)\s+(-?\d+)$/);
    if (!match) throw new Error(`経路出力の${index + 1}行目を解析できません: ${line}`);
    return [Number(match[1]), Number(match[2])];
  });
  const metricsLine = lines.slice(end + 1).find((line) => line.startsWith("__GB_METRICS__ "));
  const metricsMatch = metricsLine?.match(/^__GB_METRICS__\s+([0-9.]+)\s+(\d+)$/);
  if (!metricsMatch) throw new Error("実行時間とメモリの計測結果を取得できませんでした。");

  return {
    path,
    metrics: {
      timeMs: Number(metricsMatch[1]),
      memoryKb: Number(metricsMatch[2]),
    },
    userOutput: [...lines.slice(0, start), ...lines.slice(end + 1).filter((line) => !line.startsWith("__GB_METRICS__"))]
      .filter(Boolean)
      .join("\n"),
  };
}
