import { prompting } from "./promptingGemini.js";

var context = `Respond with the number of stitches and rows per in in the gauge schema,  as  well as the stitch count for the size of each section the knitter wants to make. The knitter would like to make the third size. 
                
            Gauge 22 stitches × 32 rows = 4 × 4 in in stockinette stitch on 4mm (US 6) circular needles = approx. 5.5 stitches and 8 rows per inch (measured after washing and blocking)

            Ribbing R1: Using a German Twisted Cast On (or desired elastic cast on method), cast on (132) 144 (156) 180 168 (204) sts on 3mm (US 2.5) needles and place a stitch marker before joining in the round, being careful not to twist your work. Work 2x2 ribbing in the round for (60) 60 (65) 65 (70) rows or to desired length. NOTE: You can reduce the amount of rows for a more cropped look, or add more rows to have it hit your hip. Try it on as you go!
            
            Bust shaping Switch to 4mm (US 6) needles. R1: Knit all (132) 144 (156) 180 (204) sts in the round. 168 R2: (Increase round) XS: Work [(K1, kfb) 5 times, then K1]; repeat 12 times - you should end up with 192 sts total. S: [(K1, kfb), (K1, kfb), (K2, kfb), (K1, kfb), (K2, kfb)] repeat 12 times - you should end up with 204 sts total M: Work [(K1, kfb), (K2, kfb)] 31 times, knit 1 - you should end up with 218 sts total L: Work (K1, kfb, K1, kfb, K1) 36 times - you should end up with 252 sts total XL: (K2, kfb) 66 times, then knit the last 6 stitches - you should end up with 270 sts total Knit all (192) 204 (218) 252 (270) sts for (30) 34 (38) 40 (50) rows in the round. NOTE: If you have a smaller bust, or don’t need as much room for the top section of the Miu Top, feel free to reduce the amount of rows by an inch! Similarly, if you have a bigger bust or want extra drape, you can add an inch. It is a pretty customizable pattern :)

            Splitting off armholes Divide stitches evenly for the front and back panels. R1: K(96) 102 (109) 126 (135) sts for the front panel. Place the remaining (96) 102 (109) 126 (135) sts for the back panel on spare yarn. Front panel Knit (29) 39 (39) 43 (53) rows in stockinette stitch (K on RS, P on WS), approximately (3.75 in) 5 in (5 in) 5.5 in (6.75 in) in length. Each row of the front panel will have (96) 102 (109) 126 (135) sts per row.`

prompting(context);
