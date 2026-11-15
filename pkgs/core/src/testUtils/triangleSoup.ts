/** Whether any triangle of a flat [x, y, ...] triangle soup contains the point. */
export function coversPoint(
	triangles: number[],
	x: number,
	y: number,
): boolean {
	for (let i = 0; i < triangles.length; i += 6) {
		const crosses = [0, 2, 4].map((offset, index) => {
			const next = ((index + 1) % 3) * 2;
			return (
				(triangles[i + next] - triangles[i + offset]) *
					(y - triangles[i + offset + 1]) -
				(triangles[i + next + 1] - triangles[i + offset + 1]) *
					(x - triangles[i + offset])
			);
		});
		if (
			crosses.every((value) => value >= -1e-10) ||
			crosses.every((value) => value <= 1e-10)
		)
			return true;
	}
	return false;
}
