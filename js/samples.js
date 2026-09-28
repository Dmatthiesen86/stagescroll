// Public-domain songs so the app has something to play on first launch.
// "Oh! Susanna" is deliberately in chords-over-lyrics form to exercise the converter.

const sp = n => ' '.repeat(n); // keeps the chord columns exact in the plain-text sample

export const SAMPLE_CHORDPRO = [
`{title: Amazing Grace}
{artist: John Newton (traditional)}
{key: G}
{duration: 2:40}

{start_of_verse: Verse 1}
A[G]mazing [G7]grace, how [C]sweet the [G]sound
That saved a wretch like [D]me
I [G]once was [G7]lost, but [C]now am [G]found
Was [Em]blind, but [D]now I [G]see
{end_of_verse}

{start_of_verse: Verse 2}
'Twas [G]grace that [G7]taught my [C]heart to [G]fear
And grace my fears re[D]lieved
How [G]precious [G7]did that [C]grace ap[G]pear
The [Em]hour I [D]first be[G]lieved
{end_of_verse}

{start_of_verse: Verse 3}
Through [G]many [G7]dangers, [C]toils and [G]snares
I have already [D]come
'Tis [G]grace hath [G7]brought me [C]safe thus [G]far
And [Em]grace will [D]lead me [G]home
{end_of_verse}

{start_of_verse: Verse 4}
When [G]we've been [G7]there ten [C]thousand [G]years
Bright shining as the [D]sun
We've [G]no less [G7]days to [C]sing God's [G]praise
Than [Em]when we'd [D]first be[G]gun
{end_of_verse}
`,
`{title: Red River Valley}
{artist: Traditional}
{key: D}
{duration: 3:00}

{start_of_verse: Verse 1}
From this [D]valley they say you are [A7]going
We will miss your bright eyes and sweet [D]smile
For they say you are taking the [G]sunshine
That has [A7]brightened our pathway a [D]while
{end_of_verse}

{start_of_chorus}
Come and [D]sit by my side if you [A7]love me
Do not hasten to bid me a[D]dieu
But re[D7]member the Red River [G]Valley
And the [A7]cowboy who loved you so [D]true
{end_of_chorus}

{start_of_verse: Verse 2}
Won't you [D]think of the valley you're [A7]leaving
Oh how lonely, how sad it will [D]be
Oh think of the fond heart you're [G]breaking
And the [A7]grief you are causing to [D]me
{end_of_verse}

{chorus}
`,
`{title: Oh! Susanna}
{artist: Stephen Foster (1848)}
{key: C}
{duration: 2:20}

[Verse 1]
C${sp(39)}G
I come from Alabama with my banjo on my knee
C${sp(40)}G${sp(2)}C
I'm going to Louisiana, my true love for to see
C${sp(54)}G
It rained all night the day I left, the weather it was dry
C${sp(40)}G${sp(9)}C
The sun so hot I froze to death, Susanna don't you cry

[Chorus]
F${sp(15)}C${sp(17)}G
Oh, Susanna, oh don't you cry for me
C${sp(40)}G${sp(2)}C
For I come from Alabama with my banjo on my knee
`,
];
