"""
Human-Like Behavior Simulation Toolkit for Python Automations
(Playwright, Selenium, and PyAutoGUI)

Implements 5 core human-like activity simulation patterns:
1. Natural mouse movement along curved cubic Bezier paths with acceleration/deceleration.
2. Human-like typing in small chunks with variable cadence, punctuation pauses, and realistic typo correction.
3. Task-dependent reading and thinking pauses (page loads, forms, proofreading).
4. Natural incremental scrolling with inspection pauses and micro-scroll reversals.
5. Context-aware interaction with interactability verification, confirmation reading, and sensible error recovery.
"""

import time
import math
import random
import asyncio
from typing import Tuple, List, Optional, Callable, Any, Dict


# ---------------------------------------------------------------------------
# 1. Natural Mouse Movement
# ---------------------------------------------------------------------------

class HumanMouse:
    """
    Simulates human cursor movements using cubic Bezier curves,
    ease-in-out velocity profiles, and randomized sub-pixel jitter.
    """

    def __init__(self, initial_coords: Tuple[int, int] = (150, 150)):
        self.x, self.y = initial_coords

    @staticmethod
    def ease_in_out_cubic(t: float) -> float:
        """Cubic easing function for natural acceleration and deceleration."""
        return 4 * t * t * t if t < 0.5 else 1.0 - math.pow(-2 * t + 2, 3) / 2.0

    def generate_bezier_path(
        self,
        start: Tuple[float, float],
        end: Tuple[float, float],
        steps: Optional[int] = None,
        deviation_scale: float = 0.35,
    ) -> List[Tuple[float, float]]:
        """
        Generates a non-repetitive curved trajectory between start and end coordinates.
        Uses randomized perpendicular offsets for control points.
        """
        x0, y0 = start
        x3, y3 = end
        dx = x3 - x0
        dy = y3 - y0
        dist = math.hypot(dx, dy)

        if steps is None:
            # Scaled steps based on distance: short distances use fewer steps
            steps = min(25, max(6, int(dist / 35)))

        angle = math.atan2(dy, dx)
        # Random lateral deviations perpendicular to target vector
        dev1 = (random.random() - 0.5) * min(150.0, dist * deviation_scale)
        dev2 = (random.random() - 0.5) * min(150.0, dist * deviation_scale)

        # Control points
        x1 = x0 + dx * 0.28 + math.sin(angle) * dev1
        y1 = y0 + dy * 0.28 - math.cos(angle) * dev1
        x2 = x0 + dx * 0.72 + math.sin(angle) * dev2
        y2 = y0 + dy * 0.72 - math.cos(angle) * dev2

        path = []
        for i in range(1, steps + 1):
            t_linear = i / steps
            t = self.ease_in_out_cubic(t_linear)
            u = 1.0 - t

            # Cubic Bezier formula
            x = (u**3 * x0 +
                 3 * u**2 * t * x1 +
                 3 * u * t**2 * x2 +
                 t**3 * x3)
            y = (u**3 * y0 +
                 3 * u**2 * t * y1 +
                 3 * u * t**2 * y2 +
                 t**3 * y3)

            # Micro-jitter to avoid perfect robotic line
            x += (random.random() - 0.5) * 1.5
            y += (random.random() - 0.5) * 1.5
            path.append((round(x, 1), round(y, 1)))

        return path

    async def move_and_click_playwright(
        self,
        page: Any,
        selector: str,
        pre_click_pause: bool = True,
        button: str = "left",
    ) -> None:
        """
        Playwright async helper: Moves cursor smoothly along curved path and clicks.
        """
        element = await page.wait_for_selector(selector, state="visible")
        box = await element.bounding_box()
        if not box:
            raise RuntimeError(f"Element {selector} has no visible bounding box.")

        # Randomized target offset within element bounds (20% to 80% range)
        target_x = box["x"] + box["width"] * random.uniform(0.2, 0.8)
        target_y = box["y"] + box["height"] * random.uniform(0.2, 0.8)

        path = self.generate_bezier_path((self.x, self.y), (target_x, target_y))
        for px, py in path:
            await page.mouse.move(px, py)
            await asyncio.sleep(random.uniform(0.008, 0.020))

        self.x, self.y = target_x, target_y

        if pre_click_pause:
            # Human hesitation / settle pause before clicking
            await asyncio.sleep(random.uniform(0.08, 0.22))

        await page.mouse.down(button=button)
        await asyncio.sleep(random.uniform(0.04, 0.09))
        await page.mouse.up(button=button)


# ---------------------------------------------------------------------------
# 2. Human-Like Typing
# ---------------------------------------------------------------------------

class HumanKeyboard:
    """
    Simulates human typing in variable chunks, with rhythm pauses between words,
    longer thinking pauses at punctuation, and occasional realistic typo corrections.
    """

    @staticmethod
    def chunk_text(text: str) -> List[str]:
        """Splits text into small chunks of 1-3 characters."""
        chunks = []
        i = 0
        n = len(text)
        while i < n:
            char = text[i]
            # Don't merge across spaces or punctuation
            if char in " .,!?;:\n":
                chunks.append(char)
                i += 1
            elif random.random() < 0.4 and i + 1 < n and text[i + 1] not in " .,!?;:\n":
                chunks.append(text[i:i + 2])
                i += 2
            else:
                chunks.append(char)
                i += 1
        return chunks

    async def type_playwright(
        self,
        element: Any,
        text: str,
        is_phone: bool = False,
        allow_typos: bool = True,
    ) -> None:
        """
        Types text into a Playwright element using human-like rhythm and error correction.
        """
        await element.focus()

        if is_phone:
            # Phone digits typed with grouping pauses
            clean = text.strip()
            for idx, digit in enumerate(clean):
                await element.type(digit)
                # Pause slightly longer at group boundaries (e.g. area code, exchange)
                if idx in (2, 5) or (clean.startswith("+1") and idx in (1, 4, 7)):
                    await asyncio.sleep(random.uniform(0.12, 0.25))
                else:
                    await asyncio.sleep(random.uniform(0.04, 0.08))
            return

        chunks = self.chunk_text(text)
        chars_typed = 0
        review_interval = random.randint(45, 90)

        for chunk in chunks:
            # Occasional realistic editing behavior (rare typo, notice, backspace, correct)
            if allow_typos and len(text) > 20 and chunk == " " and random.random() < 0.018:
                typo_char = chr(random.randint(97, 122))
                await element.type(typo_char)
                await asyncio.sleep(random.uniform(0.14, 0.28))  # Notice mistake
                await element.press("Backspace")
                await asyncio.sleep(random.uniform(0.08, 0.16))  # Settle

            await element.type(chunk)
            chars_typed += len(chunk)

            # Variable inter-keystroke cadence
            last_char = chunk[-1]
            if last_char in ".!?\n":
                await asyncio.sleep(random.uniform(0.22, 0.48))  # Sentence boundary
            elif last_char in ",;:":
                await asyncio.sleep(random.uniform(0.10, 0.22))  # Clause boundary
            elif last_char == " ":
                await asyncio.sleep(random.uniform(0.06, 0.14))  # Word boundary
            else:
                await asyncio.sleep(random.uniform(0.025, 0.065))

            # Occasional review pause
            if chars_typed >= review_interval:
                chars_typed = 0
                review_interval = random.randint(45, 90)
                await asyncio.sleep(random.uniform(0.30, 0.65))


# ---------------------------------------------------------------------------
# 3. Reading and Thinking Pauses
# ---------------------------------------------------------------------------

class HumanPacer:
    """
    Calculates and applies task-dependent delays rather than fixed sleep intervals.
    """

    @staticmethod
    async def pause(task_type: str, content: str = "") -> None:
        """
        Pauses execution dynamically according to the complexity of the current step.
        """
        if task_type == "page_load":
            # Wait for user to orient themselves on a new page
            delay = random.uniform(0.5, 1.2)
        elif task_type == "simple_action":
            # Quick button click or simple checkbox
            delay = random.uniform(0.15, 0.35)
        elif task_type == "complex_form":
            # Inspecting multiple form fields before starting
            delay = random.uniform(0.6, 1.4)
        elif task_type == "proofread_review":
            # Scaled to the length of the text being reviewed
            char_count = len(content)
            delay = min(2.5, max(0.4, char_count * 0.007 + random.uniform(0.2, 0.5)))
        else:
            delay = random.uniform(0.2, 0.5)

        await asyncio.sleep(delay)


# ---------------------------------------------------------------------------
# 4. Natural Scrolling
# ---------------------------------------------------------------------------

class HumanScroller:
    """
    Simulates smooth, multi-increment scrolling with inspection pauses
    and realistic micro-scroll reversals.
    """

    @staticmethod
    async def scroll_playwright(
        page: Any,
        target_delta_y: int,
        steps: Optional[int] = None,
        inspect: bool = True,
    ) -> None:
        """
        Scrolls the page smoothly in multiple increments with easing.
        """
        if abs(target_delta_y) < 15:
            return

        if steps is None:
            steps = min(12, max(4, int(abs(target_delta_y) / 60)))

        # Incremental scroll using ease-in-out profile
        for step in range(1, steps + 1):
            t = step / steps
            ease = 4 * t * t * t if t < 0.5 else 1.0 - math.pow(-2 * t + 2, 3) / 2.0
            step_delta = target_delta_y / steps
            await page.mouse.wheel(0, step_delta)
            await asyncio.sleep(random.uniform(0.02, 0.05))

        # Inspect relevant section
        if inspect and abs(target_delta_y) > 80:
            await asyncio.sleep(random.uniform(0.18, 0.35))
            # Micro-scroll back up slightly to re-verify information
            if random.random() < 0.35:
                back_delta = -int(math.copysign(random.randint(25, 55), target_delta_y))
                await page.mouse.wheel(0, back_delta)
                await asyncio.sleep(random.uniform(0.12, 0.25))
                await page.mouse.wheel(0, -back_delta)


# ---------------------------------------------------------------------------
# 5. Context-Aware Interaction
# ---------------------------------------------------------------------------

class ContextAwareSession:
    """
    Ensures pre-click readiness, confirms post-submission feedback,
    and implements sensible retry policies.
    """

    @staticmethod
    async def verify_clickable(element: Any, timeout: float = 8.0) -> bool:
        """
        Verifies that an element is visible, enabled, and interactable.
        """
        try:
            is_visible = await element.is_visible()
            is_enabled = await element.is_enabled()
            return is_visible and is_enabled
        except Exception:
            return False

    @staticmethod
    async def execute_with_recovery(
        action: Callable[[], Any],
        max_attempts: int = 3,
        base_delay: float = 1.0,
        recovery_callback: Optional[Callable[[int, Exception], Any]] = None,
    ) -> Any:
        """
        Executes an action with exponential backoff, jitter, and sensible recovery.
        """
        last_error = None
        for attempt in range(1, max_attempts + 1):
            try:
                return await action()
            except Exception as e:
                last_error = e
                if attempt == max_attempts:
                    break
                if recovery_callback:
                    await recovery_callback(attempt, e)
                # Exponential backoff with jitter
                delay = base_delay * (2 ** (attempt - 1)) + random.uniform(0.1, 0.4)
                await asyncio.sleep(delay)

        raise RuntimeError(f"Action failed after {max_attempts} attempts: {last_error}") from last_error

