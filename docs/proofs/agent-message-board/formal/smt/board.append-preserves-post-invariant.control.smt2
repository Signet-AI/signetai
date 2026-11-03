; benchmark generated from python API
(set-info :status unknown)
(declare-fun a_head () Int)
(declare-fun a_fresh () Int)
(declare-fun a_top () Int)
(declare-fun a_seq () (Array Int Int))
(assert
 (>= a_head 1))
(assert
 (and (distinct a_top a_fresh) true))
(assert
 (= a_seq (store ((as const (Array Int Int)) 0) a_top a_head)))
(assert
 (let ((?x961 (store a_seq a_fresh a_head)))
(let ((?x1162 (select ?x961 a_fresh)))
(let ((?x697 (select ?x961 a_top)))
(let (($x1187 (and (distinct ?x697 ?x1162) true)))
(let (($x1158 (and (distinct a_top a_fresh) true)))
(let (($x1170 (and $x1158 (> ?x697 0) (> ?x1162 0))))
(let (($x1188 (=> $x1170 $x1187)))
(not $x1188)))))))))
(check-sat)
