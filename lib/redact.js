// Redaction run on every text before it leaves the participant's computer: the user turns and
// the assistant's replies sent to the study server for classification, shared transcripts, and
// free-text answers. Personal details are replaced with placeholders and everything else is kept,
// so the study's judge model can still tell whether a message asks for advice:
//   "Should I tell my sister Emma? Text me at 415-555-0123" -> "Should I tell my sister [NAME]? Text me at [PHONE]"
// Placeholders: [URL] [EMAIL] [IP] [SSN] [CARD] [PHONE] [NUMBER] [ADDRESS] [HANDLE] [NAME].
// Names come from the participant's own list (options page) and from context: a relationship
// ("my boss, Tom,"), a title ("Dr. Patel"), an introduction ("my name is Sarah"), or a common
// first name capitalised in mid-sentence ("I told Emma").
// Attachment tags written by content/capture.js keep their syntax: "[image]" is never touched, and
// a file name is redacted with bare labels ("[file: NAME_resume_2026.pdf]"), because a "]" inside
// the tag would end it early for the server (ATTACHMENT_TAG in server/judge.py).
// NOTE: [edge case callout] regexes cannot catch every personal detail (a name at the start of a
// sentence or typed in lowercase, a nickname, an employer, a diagnosis), which is why the options
// page asks for the names that matter most and the rating panel lets the participant edit a
// transcript before sharing it. The rules were tuned on real shared chats (ShareChat, WildChat):
// what remains wrongly redacted there is mostly names that are not people ("Taylor & Francis",
// "Harry Potter", "Trader Joe's", "Dr" for debit in accounting), @-variables in code and long
// numbers in arithmetic.
(function (root) {
  // ---------------- word lists ----------------
  // A common first name counts as a name only when capitalised in mid-sentence (at the start of a
  // sentence every word is capitalised, so the capital says nothing).
  // NOTE: [design thought] left out are names that are ordinary words even when capitalised in
  // mid-sentence: months and modals (April, May, June, August, Will), virtues, flowers and gems
  // (Grace, Hope, Faith, Joy, Rose, Lily, Ruby, Amber), verbs, nouns and adjectives (Mark, Bill,
  // Frank, Rich, Pat, Art, Sandy, Chase, Hunter, Grant, Dean, Guy, Ray, Dawn, Summer, and Don of
  // "Don't"), places (Jordan, Austin, Dallas, Charlotte, Madison, Georgia, Paris), products,
  // languages and assistants (Alexa, Claude, Julia, Ada, Max, Mercedes, Tesla, Louis Vuitton) and
  // eponyms of school subjects (Taylor series, Addison's disease). Bob, Jack, Rob, Sue and Drew
  // stay: as verbs or nouns they are lowercase in mid-sentence. A left-out name is still caught in
  // context: "my son Will", "Dr. Taylor", "my name is Grace".
  const FIRST_NAMES = `
    Aaron Abigail Adam Adrian Adriana Ahmed Aidan Aiden Aisha Alan Albert Alberto Alejandro Alex
    Alexander Alexandra Alexis Alfred Ali Alice Alicia Alison Allen Allison Alvin Alyssa Amanda
    Amelia Amir Amit Amy Ana Ananya Andre Andrea Andrew Andy Angela Angelica Anita Ann Anna Anne
    Annie Anthony Antonio Aria Ariana Arjun Arthur Asher Ashley Audrey Ava Avery
    Barbara Barry Beatrice Becky Bella Ben Benjamin Bernard Beth Bethany Betty Beverly Bianca
    Billy Blake Bob Bobby Bonnie Brad Bradley Brandon Brenda Brendan Brent Brett Brian Brianna
    Bridget Brittany Brooke Bruce Bryan Bryce
    Caitlin Caleb Calvin Cameron Camila Carl Carla Carlos Carmen Carol Caroline Carolyn Carter
    Catherine Cecilia Charles Charlie Cheryl Chloe Chris Christina Christine Christopher Cindy
    Claire Clara Clarence Claudia Clayton Cody Colin Colleen Connor Corey Courtney Craig Curtis
    Cynthia
    Dale Damian Dan Dana Daniel Daniela Danielle Danny Darren Dave David Debbie Deborah Debra
    Deepak Denise Dennis Derek Devin Diana Diane Diego Divya Dominic Donald Donna Doris Dorothy
    Douglas Drew Dustin Dylan
    Eddie Edgar Eduardo Edward Edwin Elaine Eleanor Elena Eliana Elias Elijah Elizabeth Ella Ellen
    Ellie Elliot Emilia Emily Emma Emmett Eric Erica Erik Erin Esther Ethan Eva Evan Evelyn Ezra
    Fatima Felix Fernando Fiona Francis Francisco Fred Frederick
    Gabriel Gabriela Gabriella Gabrielle Gary Gavin George Gerald Gilbert Gina Glenn Gloria Gordon
    Graham Greg Gregory
    Hailey Haley Hannah Harold Harper Harry Hassan Hector Heidi Helen Henry
    Ian Irene Isaac Isabel Isabella Isabelle Isaiah Isla Ivan
    Jack Jacob Jacqueline Jake James Jamie Jane Janet Janice Jared Jason Javier Jay Jean Jeff
    Jeffrey Jenna Jennifer Jenny Jeremy Jerome Jerry Jesse Jessica Jill Jim Jimmy Joan Joanna
    Jocelyn Joe Joel John Johnny Jon Jonathan Jorge Jose Joseph Josephine Josh Joshua Josiah Joyce
    Juan Judith Judy Julian Julie Justin
    Kai Karen Karl Kate Katelyn Katherine Kathleen Kathryn Kathy Katie Kayla Keith Kelly Kelsey
    Ken Kendra Kenneth Kevin Kim Kimberly Kristen Kristin Kyle Kylie
    Larry Laura Lauren Laurie Lawrence Layla Leah Leon Leonard Leslie Liam Lila Lillian Linda
    Lindsay Lindsey Lisa Logan Lori Lucas Lucy Luis Luke Lydia Lynn
    Mackenzie Madeline Malcolm Manuel Marco Marcus Maria Mariana Marie Marilyn Marissa Martha
    Martin Marvin Mary Mason Mateo Matt Matthew Maya Megan Mei Melanie Melissa Mia Michael
    Michelle Miguel Mike Mila Miranda Mitchell Mohammed Molly Monica
    Nancy Naomi Natalia Natalie Natasha Nathan Nathaniel Neha Neil Nicholas Nick Nicole Nina Noah
    Nolan Nora Norman
    Olivia Omar Oliver Owen
    Paige Pamela Patricia Patrick Paul Paula Pedro Peggy Penelope Peter Philip Phillip Pooja Priya
    Quinn
    Rachel Rahul Raj Ralph Randy Ravi Raymond Rebecca Regina Renee Ricardo Richard Rick Ricky Riley
    Rita Rob Robert Roberto Robin Rodney Roger Rohan Ronald Rosa Ross Roy Russell Ruth Ryan
    Sabrina Sadie Sam Samantha Samuel Sandra Sanjay Sara Sarah Scarlett Scott Sean Sebastian Selena
    Serena Seth Shane Shannon Sharon Shawn Shirley Simon Sofia Sophia Sophie Spencer Stacy Stella
    Stephanie Stephen Steve Steven Stuart Sue Susan Suzanne
    Tamara Tammy Tanya Tara Teresa Terry Theo Thomas Tim Timothy Tina Todd Tom Tommy Tony Tracy
    Travis Trevor Tyler
    Valentina Valerie Vanessa Vera Veronica Victor Vikram Vincent Vivian
    Walter Warren Wayne Wei Wesley Whitney William Wyatt
    Xavier Yvonne Zach Zachary Zoe Zoey
  `.trim().split(/\s+/);

  // Words that come right before a name and say who the person is to the writer. They count only
  // after a possessive ("my", "our", ...), so "the package manager Homebrew" and "an ex Google
  // engineer" are not names but "my manager Tom" and "my ex Jordan" are.
  const RELATIONS = `
    wife husband spouse partner fiance fiancé fiancee fiancée boyfriend girlfriend bf gf ex crush
    son sons daughter daughters kid kids child children stepson stepdaughter grandson granddaughter
    mom mum mother mommy dad father daddy stepmom stepdad stepmother stepfather parents
    brother brothers sister sisters sibling siblings cousin cousins aunt uncle niece nephew
    grandma grandpa grandmother grandfather
    boss manager supervisor coworker coworkers co-worker colleague colleagues employee intern mentor
    friend friends roommate roommates flatmate housemate classmate teammate neighbor neighbour
    teacher professor tutor coach doctor therapist counselor dentist lawyer landlord landlady
  `.trim().split(/\s+/);
  // ... and words for a person in "a guy named Kevin", "someone called Ana"
  const PERSON_WORDS = "guy girl man woman boy lady person someone somebody dude gentleman student patient".split(" ");
  const TITLES = "Mrs Mr Ms Mx Miss Dr Prof Professor Aunt Auntie Uncle Grandma Grandpa Nana Pastor".split(" ");

  // Capitalised words that are not names even right after "my boss" or a first name: Title Case
  // ("My Boss Is Toxic"), dates ("my boss Monday"), family words and titles ("my doctor, Dr. Patel":
  // the title rule then redacts Patel), template words ("Dear Dr. Last Name") and two brands.
  const NOT_NAMES = [...TITLES, ...`
    Me My Mine We Us Our You Your He Him His She Her It Its They Them Their
    The An And Or But Nor So Yet For Of In On At To From By With About As Into Over After Before
    Since Until If When While Where Who Whom Whose What Which Why How That This These Those There
    Here Is Are Was Were Be Been Am Do Does Did Has Have Had Can Could Should Would Shall Must Might
    Not No Yes Also Just Only Even Still Then Now Very Too All Any Some Every Each Both Never Always
    Maybe Please Thanks Thank Hi Hello Hey Dear Ok Okay
    Today Tomorrow Tonight Yesterday Monday Tuesday Wednesday Thursday Friday Saturday Sunday
    January February March April May June July August September October November December
    Christmas Easter Thanksgiving Halloween Hanukkah Ramadan Diwali Passover
    Mom Mum Mommy Mama Dad Daddy Papa Granny Father Mother Sister Brother Cousin
    Sir Madam Jr Sr Captain Officer Detective Sergeant Lieutenant Colonel General Major Agent
    President Senator Governor Mayor Judge King Queen Prince Princess Lady Saint Sheikh Coach
    God Lord First Last Full Name Surname Pepper Martens
  `.trim().split(/\s+/)];

  // A first name followed by one of these words names an institution, a law or a place, not a
  // person: "George Washington University", "the Logan Act", "Jane Street", "Peter Principle".
  const INSTITUTIONS = `
    University College School Academy Institute Foundation Hospital Clinic Center Centre Laboratory
    Labs Museum Library Society Association Commission Committee Act Award Prize Fund Trust Company
    Corporation Inc Ltd LLC Street Avenue Road Boulevard Park Square Station Airport Stadium Hall
    Theater Theatre Show Journal Times Post Press Review Magazine National Effect Syndrome Disease
    Method Theorem Principle Equation Paradox Problem Test Index
  `.trim().split(/\s+/);

  // NOTE: [design thought] "@word" is also code: decorators (@property, @app.route), annotations
  // (@Override), CSS at-rules (@media), doc tags (@param), SQL parameters (= @id). The handle rule
  // below keeps an @-word that starts a line (also after a comment marker: "/// @dev"), that
  // follows [ / \ = or "," (XPath [@class], node_modules\@scope, Lisp ,@body), that comes right
  // before ( / or = (@Input(), @angular/core, @var=1), and these common words anywhere, so that
  // prose like "what does @property do?" stays intact. Other @-words in code are redacted: from
  // the text alone, "(@doc" in a Lisp is indistinguishable from "(@levelsio on Twitter)".
  const CODE_AT_WORDS = `
    property staticmethod classmethod dataclass abstractmethod cached_property lru_cache cache
    wraps contextmanager pytest app router Override Test Autowired Component Injectable Inject
    Input Output NonNull Nullable Deprecated escaping media import keyframes font-face supports
    tailwind apply layer include mixin extend use param returns return type typedef throws see
    since deprecated author example link todo everyone here channel echo
  `.trim().split(/\s+/);

  // ---------------- building blocks ----------------
  const any = (words) => words.join("|");
  // NOTE: [pedagogical] \b only knows ASCII letters (it sees a boundary inside "José"), so names use
  // their own boundaries: no letter or digit on either side. "_", "-" and "." then separate words,
  // which is what file names need ("Emma_resume.pdf").
  const START = String.raw`(?<![\p{L}\p{N}])`;
  const END = String.raw`(?![\p{L}\p{N}])`;
  // one capitalised name word: Emma, McDonald, O'Brien, Jean-Luc, José
  const WORD = String.raw`(?:\p{Lu}['’])?\p{Lu}\p{Ll}+(?:\p{Lu}\p{Ll}+)?(?:-\p{Lu}\p{Ll}+)?`;
  const NOT_NAME = `(?!(?:${any(NOT_NAMES)})${END})`;
  // a capitalised word right after a name, one space apart, is its surname ("Emma Watson"); not
  // across a tab, which separates the columns of a pasted table
  const SURNAME = `(?: ${NOT_NAME}${WORD}${END})?`;
  const NAME = `${NOT_NAME}${WORD}${END}${SURNAME}`;
  const NOT_A_PERSON = `(?!(?: ${WORD})? (?:${any(INSTITUTIONS)})${END})(?! \\d+:\\d+)`;   // ... or a Bible verse: "John 3:16"
  const POSSESSIVE = String.raw`\b(?:[Mm]y|[Oo]ur|[Yy]our|[Hh]is|[Hh]er|[Tt]heir)`;
  // after ". " or at a line start (also after a quote, bracket or list bullet)
  const SENTENCE_START = String.raw`(?:^|[.!?…])[\s"'“”‘’(\[*_#>•-]*`;
  // "San Diego", "St. Paul", "Lake Charles", "Camp David": a first name inside a place name
  const PLACE = String.raw`\b(?:San|Santa|St\.?|Saint|Fort|Ft\.?|Port|Lake|Mount|Mt\.?|Cape|Camp)[ \t]+`;

  // NOTE: [pedagogical] the last digit of a card number is a check digit (the Luhn algorithm):
  // doubling every second digit from the right, and taking 9 off results above 9, makes the sum
  // of all digits a multiple of 10. Only 1 in 10 random digit runs passes, so the ISBNs,
  // timestamps and IDs of the same length are left to the number rule.
  function passesLuhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let digit = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    return sum % 10 === 0;
  }
  // IPv4 addresses that identify no one: private networks, loopback, link-local, multicast and
  // reserved ranges (netmasks), a network address ending in .0, and dotted numbers such as
  // section 1.2.4.1 or version 3.8.0.1
  const SHARED_IP = /^(?:(?:0|10|127)\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|2(?:2[4-9]|[3-5]\d)\.|\d\.\d\.\d\.\d$|.*\.0$)/;

  // ---------------- the rules, most specific first ----------------
  // Each rule is [label, pattern] or [label, pattern, accept]: every match of the pattern (that
  // accept() agrees with) becomes the placeholder. The order matters: a URL can hold an e-mail, a
  // card number looks like a long number, a 4-4-4-4 card or an SSN would otherwise be read as a
  // phone number.
  // NOTE: [pedagogical] most rules start with a lookbehind such as (?<![\w.,]): a match can only
  // begin where a run of digits or letters begins. Besides avoiding partial matches ("x1234567"),
  // this keeps the work linear: without it, a pasted 100 kB block of digits would be retried from
  // every one of its positions.
  const URL_REST = String.raw`[^\s<>"'()\[\]{}]*[^\s<>"'()\[\]{}.,;:!?]`;    // up to a space or bracket, no final period
  const YEARS = String.raw`(?:19|20)\d\d[ -](?:19|20)\d\d[ -](?:19|20)\d\d`;    // "2016 2017 2018", a list, not a number
  const DETAILS = [
    // https://..., www.janedoe.com, and linkedin.com/in/jane-doe (a common domain ending, then a
    // path); localhost addresses in code are kept
    ["url", new RegExp(String.raw`\b(?!https?:\/\/(?:localhost|127\.0\.0\.1)\b)https?:\/\/${URL_REST}|(?<![\w.])www\.[\w-]+\.[A-Za-z]${URL_REST}|(?<![\w.-])[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|edu|gov|io|co|me|ai|dev|uk|us|ca)\/${URL_REST}`, "gu")],
    // the domain ends in two or more letters: not android.hardware.audio@2.0-service, postcss@8.x
    ["email", /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/gu],
    ["ip", /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/gu, (ip) => !SHARED_IP.test(ip)],
    ["ssn", /(?<![\w-])\d{3}[- ]\d{2}[- ]\d{4}(?![\w-])/gu],
    // grouped with spaces or dashes: 4-4-4-4 (up to 19 digits) or 4-6-5 (American Express), starting
    // as cards do (22 to 27, or 3 to 6), so never 19xx or 20xx: "2016 2017 2018 2019" is a list
    ["card", /(?<![\w-])(?:2[2-7]|[3-6]\d)\d\d[ -](?:\d{4}[ -]){2}\d{1,4}(?:[ -]\d{1,3})?(?![\w-])|(?<![\w-])3\d{3}[ -]\d{6}[ -]\d{4,5}(?![\w-])/gu],
    // ... or 13 to 19 digits in one run that start like a card (2 to 6) and pass the Luhn check
    ["card", /(?<![\w.,])[2-6]\d{12,18}(?!\w|[.,]\d)/gu, passesLuhn],
    // +1 (415) 555-0123, 415-555-0123, 415.555.0123, +44 20 7946 0958, +65 9123 4567. Not a run of
    // digits (the number rule takes it), not a decimal (12.3456789), not the year of a citation
    // ("Chem. A 11 (2023) 7066-7076"), not a list of years, and a "+" number has 9 digits or more
    // (not the sum in "1100012+1100112")
    ["phone", new RegExp(String.raw`(?<![\w+.-])(?!${YEARS})(?:\+(?=(?:\d[ .-]?){9})\d{1,3}(?:[ .-]?\d{2,5}){2,5}|(?:\+\d{1,3}[ .-]?|\d{1,3}[ -])?(?:\((?!(?:19|20)\d\d\))\d{2,4}\)[ .-]?\d{3,4}[ .-]?|\d{2,4}[ -]\d{3,4}[ -]?|\d{2,4}\.\d{3,4}\.)\d{4})(?![\w-]|[.,]\d)`, "gu")],
    // account and ID numbers. Kept: decimals (0.0012345678), amounts with cents (1234567.89),
    // round numbers (1000000) and binary (11001010)
    ["number", /(?<![\w.,])(?![01]+(?!\d))(?!\d*000(?!\d))\d{7,}(?!\w|[.,]\d)/gu],
    // 221 Baker Street, 350 5th Avenue, 123 N. Main St., PO Box 1234 (no "Court": "25 Supreme
    // Court cases"; no "Google Drive")
    ["address", /(?<![\w.,-])\d{1,5}[ \t]+(?:(?:(?!Google\b)\p{Lu}\p{Ll}+|\d+(?:st|nd|rd|th)|[NSEW]\.?)[ \t]+){1,3}(?:Street|Avenue|Road|Lane|Drive|Boulevard|Place|Terrace|Circle|Parkway|Highway|Way|(?:St|Ave|Rd|Ln|Dr|Blvd|Ct|Pl|Pkwy|Hwy)(?!\p{L})\.?)(?!\p{L})|\bP\.?[ \t]?O\.?[ \t]+Box[ \t]+\d+/gu],
    // @janedoe, @jane.doe, @jane_doe99 (see CODE_AT_WORDS for what is kept)
    ["handle", new RegExp(String.raw`(?<![\w@.\[\/\\=,\x60])(?<!=[ \t]+)@(?<!^[ \t]*(?:\/{2,}|#+|\/?\*+|--|;+)?[ \t]*@)(?!(?:${any(CODE_AT_WORDS)})(?![\w-]))[A-Za-z_][\w.-]+\w(?![\w(\/=-])`, "gmu")],
  ];

  // NOTE: [performance improvement] the (?=\p{Lu}) at the front of each name rule rejects every
  // position that does not start with a capital before the lookbehinds run.
  const NAMES_IN_CONTEXT = [
    // my sister Emma, my boss, Tom, our son Liam, my ex-boyfriend Jordan, my best friend (Ana)
    ["name", new RegExp(String.raw`(?=\p{Lu})(?<=${POSSESSIVE}(?:[ \t]+[\p{Ll}'’-]+){0,2}(?:[ \t]+|-)(?:${any(RELATIONS)})(?:[ -]in[ -]law)?(?:,[ \t]*|[ \t]+|[ \t]*\())${NAME}`, "gu")],
    // Dr. Patel, Mrs Lee, Mr. John Smith, Prof. Chen, Aunt Sarah
    ["name", new RegExp(String.raw`(?=\p{Lu})(?<=\b(?:${any(TITLES)})\.?[ \t]+)${NAME}`, "gu")],
    // my name is Sarah, her name's Ana, call me Sam, goes by Sam, a coworker named Kevin, someone called Ana
    ["name", new RegExp(String.raw`(?=\p{Lu})(?<=\b(?:(?:[Mm]y|[Oo]ur|[Yy]our|[Hh]is|[Hh]er|[Tt]heir|\p{Ll}+['’]s)[ \t]+name(?:['’]s|[ \t]+is|[ \t]+was)|[Cc]all(?:ed)?[ \t]+me|(?:go|goes|went)[ \t]+by|(?:${any([...PERSON_WORDS, ...RELATIONS])})(?:[ \t]+(?:is|was))?[ \t]+(?:named|called))[ \t]+)${NAME}`, "gu")],
  ];
  // I told Emma, ask Emma Watson; not "Emma said ..." at a sentence start, not "San Diego"
  const FIRST_NAME_IN_TEXT = ["name", new RegExp(String.raw`(?=\p{Lu})${START}(?<!${SENTENCE_START})(?<!${PLACE})(?:${any(FIRST_NAMES)})${END}${NOT_A_PERSON}${SURNAME}`, "gmu")];
  // a file name has no sentences: "Emma_Watson_resume.pdf", "Emma-cv.docx"
  const FIRST_NAME_IN_FILE_NAME = ["name", new RegExp(String.raw`${START}(?:${any(FIRST_NAMES)})${END}(?:[ _.-]${NOT_NAME}${WORD}${END})?`, "gu")];

  // The participant's own list (options page): any case, whole words, longest first so that
  // "Alex Rivera" wins over "Alex"; the words of a name may be joined by _ - . as in a file name.
  function listedNames(names) {
    const patterns = names.map((name) => name.trim()).filter((name) => name.length > 1)
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, String.raw`[\s_.-]+`));
    return patterns.length ? [["name", new RegExp(`${START}(?:${patterns.join("|")})${END}`, "giu")]] : [];
  }

  // Text no rule may change: a placeholder written by an earlier rule or an earlier run, and the
  // attachment tags. This is what makes redact(redact(x).text) return the same text.
  const PLACEHOLDERS = ["url", "email", "ip", "ssn", "card", "phone", "number", "address", "handle", "name"];
  const KEPT = new RegExp(String.raw`\[(?:${PLACEHOLDERS.map((label) => label.toUpperCase()).join("|")})\]|\[image\]|\[file: [^\]\n]*\]`, "u");
  const FILE_TAG = /\[file: ([^\]\n]*)\]/g;

  function applyRules(text, rules, counts, placeholder) {
    let out = text;
    for (const [label, pattern, accept] of rules) {
      // NOTE: [pedagogical] at every position the alternation tries KEPT first: a placeholder or a
      // tag is consumed whole and given back unchanged, so no rule can match inside it
      // NOTE: [performance improvement] these combined patterns could be built once at load time;
      // V8 caches compiled regexes by source and flags, so building them on each call costs little
      const keptOrMatch = new RegExp(`(${KEPT.source})|${pattern.source}`, pattern.flags);
      out = out.replace(keptOrMatch, (match, kept) => {
        if (kept !== undefined || (accept && !accept(match))) return match;
        counts[label] = (counts[label] || 0) + 1;
        return placeholder(label);
      });
    }
    return out;
  }

  function redact(text, names = []) {
    const counts = {};
    const listed = listedNames(names);
    // file names first, with bare labels (NAME, EMAIL, ...) so that the tag stays one tag
    let out = text.replace(FILE_TAG, (tag, fileName) => {
      const rules = [...DETAILS, ...listed, ...NAMES_IN_CONTEXT, FIRST_NAME_IN_FILE_NAME];
      return `[file: ${applyRules(fileName, rules, counts, (label) => label.toUpperCase())}]`;
    });
    const rules = [...DETAILS, ...listed, ...NAMES_IN_CONTEXT, FIRST_NAME_IN_TEXT];
    out = applyRules(out, rules, counts, (label) => `[${label.toUpperCase()}]`);
    return { text: out, counts };
  }

  function redactMessages(messages, names) {
    let counts = {};
    const redacted = messages.map((m) => {
      const result = redact(m.content, names);
      for (const [k, v] of Object.entries(result.counts)) counts[k] = (counts[k] || 0) + v;
      return { role: m.role, content: result.text };
    });
    return { messages: redacted, counts };
  }

  const api = { redact, redactMessages };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Redact = api;
})(typeof self !== "undefined" ? self : globalThis);
