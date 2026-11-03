; benchmark generated from python API
(set-info :status unknown)
(declare-fun b_owner () Int)
(declare-fun b_count () Int)
(declare-fun b_used () Int)
(declare-fun b_limit () Int)
(declare-fun b_size () Int)
(declare-fun b_pending () Int)
(declare-fun b_cap () Int)
(declare-fun b_head () Int)
(declare-fun b_seq () (Array Int Int))
(declare-fun b_mem (Int Int) Bool)
(assert
 (= b_owner (- 1)))
(assert
 (= b_count 0))
(assert
 (= b_used 0))
(assert
 (> b_limit 0))
(assert
 (= b_size 0))
(assert
 (= b_pending 0))
(assert
 (> b_cap 0))
(assert
 (= b_head 0))
(assert
 (forall ((b_p Int) )(let ((?x30 (select b_seq b_p)))
 (= ?x30 0)))
 )
(assert
 (forall ((b_b Int) (b_m Int) )(not (b_mem b_b b_m)))
)
(check-sat)
