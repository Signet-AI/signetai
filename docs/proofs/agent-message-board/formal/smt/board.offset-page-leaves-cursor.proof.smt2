; benchmark generated from python API
(set-info :status unknown)
(declare-fun o_offset () Int)
(declare-fun o_read () Int)
(declare-fun o_cutoff () Int)
(assert
 (> o_offset 0))
(assert
 (>= o_read 0))
(assert
 (> o_cutoff o_read))
(assert
 (let (($x1196 (= o_offset 0)))
(let (($x960 (= (ite $x1196 (ite (>= o_read o_cutoff) o_read o_cutoff) o_read) o_read)))
(not $x960))))
(check-sat)
