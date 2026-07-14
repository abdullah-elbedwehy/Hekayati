# Canonical Seed Templates

**Feature**: `004-story-authoring-and-templates`

**Requirement**: FR-050/053, US10-AS1

**Content version**: 1

These seven records are the normative first-run content. They are parameterized Arabic structures, never stories with a fixed child's name. Runtime data must use the stable keys exactly; the installer must not overwrite any existing key.

Shared role-slot conventions:

- `hero` is required and maps to one selected non-pet project character.
- Optional role slots may stay empty; content compilation must not invent a person for an empty slot.
- `friend` may use relationship `friend`; `family_support` accepts a selected parent/sibling/grandparent; `helper` may use any selected non-pet role; `pet_companion` requires relationship `pet`.
- Every ending returns attention to the hero and may weave the selected hidden goal only in the configured indirect or acknowledged-ending mode.

## 1. `space_adventure` — مغامرة الفضاء

**Premise**: البطل يكتشف إشارة غامضة جاية من مكان بعيد، ويقود رحلة فضائية صغيرة لحل لغز يساعد كوكبًا لطيفًا من غير قتال أو تخويف.

**Structure**:

1. `invitation` — تظهر الإشارة ويختار البطل إنه يفهمها بدل ما يتجاهلها.
2. `launch_and_discovery` — تجهيز الرحلة، عبور الفضاء، واكتشاف إن المشكلة مختلفة عن أول توقع.
3. `cooperative_solution` — الشخصيات تجمع ملاحظاتها وتجرّب حلًا آمنًا قائمًا على التعاون.
4. `return_with_wonder` — الكوكب يستعيد بهجته، والفريق يرجع وهو شايل ذكرى صغيرة من المغامرة.

**Environments**: أوضة البطل ليلًا؛ مركبة فضائية خيالية؛ ممر نجوم ملوّن؛ كوكب بحدائق مضيئة؛ ساحة احتفال هادئة.

**Role slots**: `hero` required/narrative `قائد الرحلة`; `friend` optional/`شريك الاكتشاف`; `family_support` optional/`مساند من الأرض`; `pet_companion` optional/`رفيق مرح`.

**Variables**:

- `signal_source` (text, required, default `نجمة بتومض بنغمة غريبة`) — مصدر الإشارة.
- `space_vehicle` (text, required, default `مركبة صغيرة بلون الليمون`) — وسيلة الرحلة.
- `planet_problem` (text, required, default `أضواء الحديقة اختفت`) — اللغز القابل للحل.
- `souvenir` (text, optional, default `حجر نجمي لامع`) — تذكار غير تجاري.

**Possible hidden goals**: الثقة؛ الشجاعة الهادئة؛ التعاون؛ المسؤولية؛ تقبّل فكرة جديدة.

**Scene guidance**: ابدأ بدهشة قريبة من عالم الطفل؛ اجعل الفضاء ملوّنًا ومطمئنًا؛ أعطِ كل مشارك فعلًا واضحًا؛ لا تحل المشكلة بقوة خارقة مفاجئة؛ اختم بصورة عودة دافئة.

**Age adaptation**: 3–5: هدف واحد وخطوات بصرية متكررة؛ 6–8: دليلان ومحاولة أولى لا تنجح بالكامل؛ 9–12: سبب ونتيجة أوضح واختيار أخلاقي بسيط حول مساعدة سكان الكوكب.

**Content boundaries**: لا فراغ مرعب أو ضياع طويل؛ لا أسلحة أو حرب كواكب؛ لا خطر اختناق؛ لا كائنات شريرة بشكل صادم؛ لا امتياز لشخصية غير مختارة.

**Ending patterns**: وداع سكان الكوكب للبطل؛ رؤية الأرض من بعيد؛ التذكار على رف البطل مع جملة «الحكايات الكبيرة بتبدأ بسؤال صغير».

## 2. `treasure_island` — جزيرة الكنز

**Premise**: خريطة قديمة تقود البطل وفريقه لجزيرة مليانة علامات طبيعية وألغاز لطيفة، والكنز الحقيقي يطلع حاجة نافعة يشاركوا أثرها.

**Structure**:

1. `map_found` — العثور على الخريطة وفهم أول علامة.
2. `island_trail` — الوصول للجزيرة واتباع ثلاث إشارات من البيئة.
3. `choice_at_the_cave` — الفريق يختار طريقًا آمنًا ويتقاسم الأدوار عند اللغز الأخير.
4. `shared_treasure` — فتح الصندوق واكتشاف قيمة المشاركة أو المعرفة داخله.

**Environments**: رصيف صغير؛ مركب شراعي خيالي آمن؛ شاطئ ذهبي؛ غابة نخيل؛ كهف واسع مضيء؛ مكان العودة.

**Role slots**: `hero` required/`قارئ الخريطة`; `friend` optional/`ملاحظ العلامات`; `family_support` optional/`حافظ الأمان`; `pet_companion` optional/`مكتشف الأثر`.

**Variables**:

- `map_origin` (text, required, default `كتاب قديم في المكتبة`) — مكان العثور على الخريطة.
- `three_clues` (list of text, required, default `نخلة منحنية؛ صخرة زي الهلال؛ شلال صغير`) — ثلاث إشارات قابلة للرسم.
- `treasure` (text, required, default `بذور نادرة ودفتر حكايات`) — كنز غير قائم على المال وحده.
- `sharing_choice` (text, optional, default `يزرعوا البذور مع العيلة`) — أثر العودة.

**Possible hidden goals**: المشاركة؛ الصبر؛ التعاون؛ الاستمتاع بالقراءة؛ تحمّل المسؤولية.

**Scene guidance**: حافظ على مسار مكاني مفهوم؛ اجعل الألغاز مرئية وقابلة للحل؛ لا تجعل شخصًا واحدًا يعرف كل شيء؛ ضع لحظة قرار قبل الصندوق؛ أبرز فرحة الاكتشاف لا قيمة الذهب.

**Age adaptation**: 3–5: رموز كبيرة وثلاث محطات؛ 6–8: لغز قافية بسيط؛ 9–12: خريطة ناقصة تتطلب مقارنة الأدلة واحترام أثر قديم.

**Content boundaries**: لا قراصنة عنيفين؛ لا سرقة من أهل الجزيرة؛ لا غرق أو عاصفة مرعبة؛ لا كنز مسروق أو سلاح؛ لا دخول مكان خطير بلا اختيار آمن.

**Ending patterns**: زراعة بذور الكنز؛ مشاركة دفتر الحكايات؛ ترك الجزيرة أنظف مما كانت؛ علامة صغيرة على الخريطة تقول إن التعاون هو المفتاح.

## 3. `dinosaur_world` — عالم الديناصورات

**Premise**: بوابة علمية خيالية تفتح على وادٍ قديم، فيساعد البطل ديناصورًا صغيرًا يرجع لقطيعه وهو يلاحظ الفرق بين الأنواع باحترام وفضول.

**Structure**:

1. `portal_opens` — اكتشاف البوابة ووضع قاعدة رجوع آمنة.
2. `gentle_encounters` — مقابلة ديناصورات مسالمة وفهم بيئتها.
3. `lost_hatchling` — مساعدة صغير تاه بسبب عائق طبيعي غير مرعب.
4. `safe_return` — لمّ الشمل والعودة قبل إغلاق البوابة.

**Environments**: ركن علوم أو متحف؛ بوابة زمنية ملوّنة؛ وادٍ أخضر؛ بحيرة ضحلة؛ عش دافئ؛ ركن العودة.

**Role slots**: `hero` required/`المستكشف الحريص`; `friend` optional/`مسجل الملاحظات`; `family_support` optional/`مرشد الرجوع`; `pet_companion` optional/`ملاحظ الروائح`.

**Variables**:

- `portal_trigger` (text, required, default `قطعة حجر عليها أثر قدم`) — سبب البوابة.
- `hatchling_kind` (text, required, default `ديناصور نباتي صغير`) — نوع الصغير من غير ادعاء علمي دقيق إذا لم يُحدد.
- `natural_obstacle` (text, required, default `جذع شجرة وقع على الممر`) — عائق آمن.
- `observation_tool` (text, optional, default `كراسة ورسمة`) — أداة بلا إيذاء.

**Possible hidden goals**: الشجاعة؛ حب التعلّم؛ الرفق بالحيوان؛ الصبر؛ طلب المساعدة.

**Scene guidance**: حافظ على اختلاف أحجام واضح من غير تهديد؛ اجعل الديناصورات حيوانات لا وحوشًا ناطقة كلها؛ استخدم الملاحظة قبل الاقتراب؛ لا تغيّر التاريخ أو تأخذ بيضة.

**Age adaptation**: 3–5: أسماء وصفية بسيطة وأصوات لطيفة؛ 6–8: فرق بين آكل النبات وغيره من بعيد؛ 9–12: ملاحظة آثار وموطن وسلوك من غير محاضرة.

**Content boundaries**: لا افتراس ظاهر أو دم؛ لا مطاردة رعب؛ لا لمس بيض أو فصل صغير عن أمه؛ لا ادعاء علمي قطعي لمعلومة غير مؤكدة؛ لا أسلحة.

**Ending patterns**: طبعة قدم مرسومة في الكراسة؛ الصغير يلوّح بذيله من بعيد؛ البطل يحكي ما تعلّمه من الملاحظة الهادئة.

## 4. `imaginary_city_rescue` — إنقاذ مدينة خيالية

**Premise**: مدينة خيالية تفقد شيئًا أساسيًا لبهجتها، ويقود البطل خطة مدنية صغيرة تجمع مهارات الناس بدل انتظار منقذ خارق.

**Structure**:

1. `city_call` — وصول رسالة من المدينة وتحديد المشكلة من كلام أهلها.
2. `listen_and_map` — جولة قصيرة لسماع ثلاث وجهات نظر ورسم خريطة للمشكلة.
3. `team_plan` — توزيع أدوار وتنفيذ حل قابل للتراجع بأمان.
4. `city_returns` — عودة اللون/الماء/الموسيقى واحتفال يذكر مساهمة الجميع.

**Environments**: بوابة المدينة؛ ميدان بأشكال مرحة؛ ورشة صغيرة؛ حديقة أو قناة؛ سطح مرتفع آمن؛ احتفال مسائي.

**Role slots**: `hero` required/`منسق الخطة`; `friend` optional/`جامع الأفكار`; `family_support` optional/`مراجع الأمان`; `helper` optional/`خبير محلي`.

**Variables**:

- `city_name` (text, required, default `مدينة الفوانيس`) — اسم خيالي أصلي.
- `missing_joy` (text, required, default `النور الملوّن في الشوارع`) — المشكلة.
- `citizen_skills` (list of text, required, default `الرسم؛ الإصلاح؛ تنظيم الطريق`) — مهارات متعاونة.
- `celebration` (text, optional, default `موكب فوانيس هادي`) — نهاية آمنة.

**Possible hidden goals**: القيادة المتعاونة؛ المسؤولية؛ الثقة؛ الاستماع؛ الترحيب باختلاف الأفكار.

**Scene guidance**: لا تجعل البطل يأمر الجميع؛ أظهر الاستماع والتجربة؛ اجعل الحل نتيجة أدوار محددة؛ حافظ على مدينة أصلية بلا تشابه مع امتياز معروف.

**Age adaptation**: 3–5: مشكلة حسية واضحة وحلين بسيطين؛ 6–8: آراء مختلفة وتجربة صغيرة؛ 9–12: قيد في الموارد ومفاضلة عادلة مع مراجعة النتيجة.

**Content boundaries**: لا حرب أو شرطة عنيفة؛ لا انهيار مبانٍ أو إصابات؛ لا حاكم شرير نمطي؛ لا تقليد مدينة/بطل من عمل معروف؛ لا سخرية من صاحب فكرة لم تنجح.

**Ending patterns**: لوحة شكر بأدوار الجميع؛ ضوء يعود بالتدريج؛ البطل يسلّم خريطة الخطة لأهل المدينة ثم يرجع.

## 5. `underwater_journey` — رحلة تحت الماء

**Premise**: في مركبة آمنة تحت الماء، يستكشف البطل عالم الشعاب ويساعد الكائنات تنظّم موطنها بعد تغيّر بسيط من غير لمسها أو إخافتها.

**Structure**:

1. `dive_preparation` — تجهيز المركبة وقواعد الملاحظة.
2. `reef_wonders` — لقاء كائنات مختلفة وملاحظة علامة على المشكلة.
3. `current_puzzle` — فهم تيار/حطام آمن وتنفيذ مساعدة لا تضر البيئة.
4. `surface_and_share` — عودة آمنة وتوثيق ما يستحق الحماية.

**Environments**: شاطئ هادئ؛ مركبة زجاجية خيالية؛ شعاب ملوّنة؛ غابة أعشاب بحرية؛ كهف مضيء من الخارج؛ سطح البحر وقت الغروب.

**Role slots**: `hero` required/`قائد الملاحظة`; `friend` optional/`مسجل الكائنات`; `family_support` optional/`مسؤول السلامة`; `pet_companion` excluded by default داخل الماء.

**Variables**:

- `vehicle` (text, required, default `غواصة صغيرة بنافذة كبيرة`) — وسيلة آمنة.
- `sea_friend` (text, required, default `سلحفاة بحرية فضولية`) — كائن لا يُمتلك.
- `reef_problem` (text, required, default `حبال نباتية علقت في صخرة وسدت الممر`) — مشكلة غير صادمة.
- `care_action` (text, optional, default `توجيه روبوت صغير لفكها من بعيد`) — حل لا يلمس الكائن.

**Possible hidden goals**: الرفق؛ المسؤولية؛ الصبر؛ تقليل الهدر؛ العمل الجماعي.

**Scene guidance**: ركّز على الضوء والحركة الهادئة؛ لا تجعل الحيوانات أدوات؛ احترم المسافة؛ اجعل قرار العودة جزءًا من الشجاعة.

**Age adaptation**: 3–5: ثلاثة كائنات وألوان واضحة؛ 6–8: سلسلة غذاء بسيطة بلا افتراس ظاهر؛ 9–12: أثر بيئي صغير وخيارات مساعدة محدودة.

**Content boundaries**: لا غرق أو نفاد أكسجين؛ لا قرش مرعب أو هجوم؛ لا جمع مرجان/حيوان؛ لا تلوث صادم؛ لا قيادة طفل لمعدة حقيقية بلا إطار خيالي آمن.

**Ending patterns**: ألبوم رسومات للكائنات؛ موجة توديع من السلحفاة؛ وعد بفعل صغير يحافظ على الشاطئ من غير وعظ.

## 6. `unforgettable_birthday` — عيد ميلاد لا يُنسى

**Premise**: مفاجأة عيد ميلاد بسيطة تتعطل بطريقة مضحكة، فيحوّل البطل والناس المختارون الموقف ليوم شخصي ودافئ أهم من الزينة أو الهدايا.

**Structure**:

1. `small_wish` — البطل يختار أمنية أو نشاطًا يحبه بدل قائمة مشتريات.
2. `surprise_wobble` — تفصيلة في الخطة لا تمشي كما توقعوا من غير لوم.
3. `make_it_together` — الجميع يعيدون ترتيب اليوم بمواد وأفكار متاحة.
4. `memory_moment` — لحظة احتفال شخصية وصورة وداع دافئة.

**Environments**: البيت أو الحديقة؛ ركن تجهيز؛ مكان النشاط المختار؛ طاولة بسيطة؛ مساحة صورة جماعية.

**Role slots**: `hero` required/`صاحب اليوم`; `friend` optional/`شريك النشاط`; `family_support` optional and repeatable/`صانع المفاجأة`; `pet_companion` optional/`موقف مرح`.

**Variables**:

- `favorite_activity` (text, required, default `لعبة بحث عن ألوان`) — قلب اليوم.
- `plan_wobble` (text, required, default `الزينة اتلخبط ترتيبها`) — تعطل غير مؤذٍ.
- `handmade_detail` (text, required, default `تيجان ورق مرسومة بالإيد`) — بديل شخصي.
- `birthday_message` (text, optional, default `وجودك هو أحلى حاجة في اليوم`) — معنى بلا مقارنة.

**Possible hidden goals**: تقبّل التغيير؛ الامتنان؛ المشاركة؛ الترحيب بأخ/أخت؛ تقليل التعلق بالهاتف.

**Scene guidance**: لا تقيس الحب بعدد الهدايا؛ لا تحرج البطل أمام الناس؛ اجعل التعطل فرصة مرحة؛ اسمح باحتفال صغير إذا كان هذا اختيار المشروع.

**Age adaptation**: 3–5: تسلسل تجهيز واضح وتكرار لطيف؛ 6–8: البطل يختار بين بديلين؛ 9–12: يشارك في التصميم ويحترم ميزانية/وقتًا من غير خطاب مالي.

**Content boundaries**: لا مقالب مخيفة؛ لا سخرية من الشكل/العمر؛ لا مقارنة بإخوة أو أصدقاء؛ لا ضغط على طفل خجول؛ لا علامة تجارية أو منتج لازم للسعادة.

**Ending patterns**: صورة جماعية اختيارية؛ صندوق ذكريات ورقية؛ رسالة قصيرة من الشخصيات المختارة؛ لحظة هادئة بعد انتهاء الاحتفال.

## 7. `fully_custom` — قصة مخصّصة بالكامل

**Premise**: مساحة منظمة يحوّل فيها operator فكرة الأسرة إلى قصة أصلية، مع حد أدنى واضح يمنع التوليد الغامض ويحافظ على دور كل شخصية وحدود المحتوى.

**Structure**:

1. `beginning` — الحدث الافتتاحي الذي يغيّر يوم البطل.
2. `development` — محاولات مرتبة وعلاقة الشخصيات بالمشكلة.
3. `turning_point` — اختيار البطل أو اكتشافه الأساسي.
4. `ending` — نتيجة الاختيار، العودة الهادئة، ولحظة الوداع.

**Environments**: متغير مطلوب يحدده operator؛ يمكن إضافة حتى خمس بيئات مرتبة، ولا تُستنتج أماكن خاصة من بيانات العميل.

**Role slots**: `hero` required/`البطل`; `companion_1` optional/`رفيق أول`; `companion_2` optional/`رفيق ثانٍ`; `family_support` optional/`مساند`; `pet_companion` optional/`رفيق حيوان`.

**Variables**:

- `custom_premise` (long text, required, no default) — C-23 premise.
- `beginning_beat` (long text, required, no default).
- `middle_beat` (long text, required, no default).
- `ending_beat` (long text, required, no default).
- `primary_environment` (text, required, no default).
- `content_boundaries` (list of text, required, minimum 1, no default).
- `must_include` (list of text, optional, default empty).

**Possible hidden goals**: كل قيم FR-048، بما فيها `custom` مع وصف operator؛ لا يُضاف هدف تلقائيًا.

**Scene guidance**: حافظ على ترتيب الضربات الثلاث؛ أعطِ كل مشارك مختار وظيفة؛ ميّز الحقيقة المطلوبة من الخيال؛ اترك الحقول الناقصة كمسودة واضحة ولا تخمّنها.

**Age adaptation**: 3–5: مشكلة واحدة وشخصيات قليلة وتكرار مطمئن؛ 6–8: سبب/نتيجة ومحاولتان؛ 9–12: دوافع أوضح ونتيجة مركبة من غير ثقل أو وعظ.

**Content boundaries**: قائمة operator المطلوبة هي الحد الأدنى؛ تضاف دائمًا الحدود المشتركة: لا لوم أو وصم للطفل، لا معلومات اتصال، لا تفاصيل حساسة غير لازمة، لا تقليد امتياز/فنان حي، ولا شخص غير مختار.

**Ending patterns**: يختار operator بين عودة دافئة، احتفال صغير، اكتشاف هادئ، أو وعد بفعل لاحق؛ صفحة الوداع وصفحة العلامة تظلان قابلتين للتحرير في المشروع.

## Validation checklist

Each seed must validate with:

- one non-empty premise;
- exactly four ordered structural beats with stable keys and non-empty purposes;
- at least one environment;
- one required `hero` role slot and unique slot keys;
- unique variable keys with explicit type/required/default semantics;
- at least one hidden-goal option, scene-guidance entry, age rule for each canonical age band, content boundary, and ending pattern;
- no customer/character IDs, names, photos, paths, contact details, provider/model IDs, secrets, or fixed franchise/living-artist references.
