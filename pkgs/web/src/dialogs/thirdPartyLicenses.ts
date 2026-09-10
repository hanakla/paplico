/**
 * Attribution data shown by LicensesDialog.
 *
 * Two categories, because they carry different obligations:
 * `BUNDLED_LICENSES` covers assets we ship and code we ported, where the
 * upstream license requires its text to travel with the work.
 * `ALGORITHM_REFERENCES` covers work we only read and reimplemented, where
 * credit is owed but no license text applies.
 */

interface ThirdPartyLicense {
	name: string;
	/** Short license label, SPDX identifier where one exists. */
	license: string;
	/** What the work is used for in Paplico. */
	used: string;
	/** Where the work itself lives. */
	url: string;
	body: string;
}

interface AlgorithmReference {
	name: string;
	license: string;
	url: string;
	/** What was taken — always an idea, never the upstream source text. */
	used: string;
}

export const BUNDLED_LICENSES: ThirdPartyLicense[] = [
	{
		name: "Compact ICC Profiles by Clinton Ingram (saucecontrol)",
		license: "CC0 1.0 Universal",
		used: "The sRGB and Display P3 profiles the canvas and export use.",
		url: "https://github.com/saucecontrol/Compact-ICC-Profiles",
		body: `All profiles in this collection are released to the public domain under the Creative Commons CC0 license. They are free from restrictions on distribution and use to the extent allowed by law.

Full text of the dedication: https://creativecommons.org/publicdomain/zero/1.0/legalcode

Profiles bundled here: sRGB-v4.icc, DisplayP3Compat-v4.icc`,
	},
	{
		name: "polybool by Sean Connelly (@velipso)",
		license: "0BSD",
		used: "Combining shapes and cutting them out of each other.",
		url: "https://github.com/velipso/polybool",
		body: `BSD Zero Clause License

Copyright (c) 2024 by Sean Connelly (https://sean.fun)

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
	},
	{
		name: "kurbo by Raph Levien and contributors",
		license: "Apache-2.0 OR MIT (used under MIT)",
		used: "Turning a drawn line into smooth curves.",
		url: "https://github.com/linebender/kurbo",
		body: `Copyright (c) 2018 Raph Levien
Copyright 2022 the Kurbo Authors

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.`,
	},
	{
		name: "BitonicPixelSorter by ruccho",
		license: "MIT",
		used: "The pixel sort filter.",
		url: "https://github.com/ruccho/BitonicPixelSorter",
		body: `MIT License

Copyright (c) 2020 ruccho

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
	},
	{
		name: "RadRotDirBlur_S by sigma-axis",
		license: "MIT",
		used: "The radial, rotational and directional blur filters.",
		url: "https://github.com/sigma-axis/aviutl_script_RadRotDirBlur_S",
		body: `MIT License

Copyright (c) 2025 sigma-axis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
	},
	{
		name: "webgl-noise by Ashima Arts and Stefan Gustavson",
		license: "MIT",
		used: "The grain inside the fluid distortion filter.",
		url: "https://github.com/ashima/webgl-noise",
		body: `Copyright (C) 2011 by Ashima Arts (Simplex noise)
Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`,
	},
	{
		name: "Noto Sans JP",
		license: "OFL-1.1",
		used: "The bundled fallback font for text on the canvas.",
		url: "https://fonts.google.com/noto/specimen/Noto+Sans+JP",
		body: `Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.`,
	},
];

export const ALGORITHM_REFERENCES: AlgorithmReference[] = [
	{
		name: "Adobe Illustrator",
		license: "Proprietary",
		url: "https://www.adobe.com/products/illustrator.html",
		used: "The grammar of vector drawing — what a handle does, what Alt means, where the pen lands next. Paplico is drawn in its shadow, with love and my own muscle memory.",
	},
	{
		name: "Vello (linebender)",
		license: "Apache-2.0 OR MIT",
		url: "https://github.com/linebender/vello",
		used: "How lines and fills are drawn on the graphics card.",
	},
	{
		name: "MyPaint",
		license: "GPL-2.0-or-later",
		url: "https://github.com/mypaint/mypaint",
		used: "Filling an area whose outline has small gaps in it.",
	},
	{
		name: "Krita",
		license: "GPL-3.0-or-later",
		url: "https://invent.kde.org/graphics/krita",
		used: "Smoothing out hand tremor while you draw.",
	},
	{
		name: "Graphics Gems (FitCurves.c) and Schneider (1990)",
		license: "Graphics Gems EULA",
		url: "https://github.com/erich666/GraphicsGems",
		used: "Turning a drawn line into smooth curves.",
	},
	{
		name: "fit-curve by soswow",
		license: "MIT",
		url: "https://github.com/soswow/fit-curve",
		used: "Turning a drawn line into smooth curves.",
	},
];
